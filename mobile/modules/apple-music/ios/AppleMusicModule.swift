import ExpoModulesCore
import MediaPlayer
import UIKit

/// Apple Music connector built on Apple's MediaPlayer framework.
///
/// - Reads the user's music library: songs added from Apple Music, purchases, synced music.
///   This needs only the media-library permission, not a paid Apple Developer account.
/// - Plays songs in the app and changes their speed (and so their BPM) with
///   `currentPlaybackRate`, which Apple allows third-party apps to change for Apple Music
///   subscription content. iOS changes speed without changing pitch.
/// - `play()` resets the rate to 1.0, so the desired rate is re-applied after every play,
///   track change and state change. `getState` also re-applies it and counts how often iOS
///   reset it (`rateResets`): if that keeps climbing, this iOS version is ignoring speed
///   changes (reported on iOS 26.0).
public class AppleMusicModule: Module {
  /// "app" = in-app player (applicationQueuePlayer), "system" = the Music app's player.
  private var playerKind = "app"
  private var desiredRate: Float = 1.0
  private var lastRateApply = Date.distantPast
  private var rateResets = 0
  private var observers: [NSObjectProtocol] = []
  private var observedPlayer: MPMusicPlayerController?

  private var player: MPMusicPlayerController {
    playerKind == "system"
      ? MPMusicPlayerController.systemMusicPlayer
      : MPMusicPlayerController.applicationQueuePlayer
  }

  public func definition() -> ModuleDefinition {
    Name("AppleMusic")

    Events("onPlaybackChange")

    Constant("isSimulator") { () -> Bool in
      #if targetEnvironment(simulator)
        return true
      #else
        return false
      #endif
    }

    OnDestroy {
      DispatchQueue.main.async {
        self.stopObserving()
        UIApplication.shared.isIdleTimerDisabled = false
      }
    }

    // ------------------------------------------------------------------ permission

    AsyncFunction("getAuthorizationStatus") { () -> String in
      Self.statusName(MPMediaLibrary.authorizationStatus())
    }

    AsyncFunction("requestAuthorization") { (promise: Promise) in
      MPMediaLibrary.requestAuthorization { status in
        promise.resolve(Self.statusName(status))
      }
    }

    // ------------------------------------------------------------------ library

    /// Library songs, most recently added first.
    AsyncFunction("getSongs") { (limit: Int, offset: Int) throws -> [String: Any] in
      guard MPMediaLibrary.authorizationStatus() == .authorized else {
        throw NotAuthorizedException()
      }
      let items = (MPMediaQuery.songs().items ?? []).sorted { $0.dateAdded > $1.dateAdded }
      let start = min(max(offset, 0), items.count)
      let end = min(start + max(limit, 0), items.count)
      return ["total": items.count, "songs": items[start..<end].map { Self.serialize($0) }]
    }

    // ------------------------------------------------------------------ playback

    /// Replace the queue with these songs (library ids) and start at `startIndex`.
    AsyncFunction("play") { (ids: [String], startIndex: Int, promise: Promise) in
      // Library lookups (one query per song) stay off the main thread; the player needs it.
      let items = ids.compactMap { Self.item(withId: $0) }
      guard !items.isEmpty else {
        promise.reject("ERR_NO_SONGS", "None of those songs are in the music library.")
        return
      }
      DispatchQueue.main.async {
        self.startObserving()
        let p = self.player
        p.setQueue(with: MPMediaItemCollection(items: items))
        if startIndex > 0 && startIndex < items.count {
          p.nowPlayingItem = items[startIndex]
        }
        p.prepareToPlay { error in
          DispatchQueue.main.async {
            if let error = error {
              promise.reject("ERR_PREPARE", "Couldn't load the song: \(error.localizedDescription)")
              return
            }
            p.play()  // resets the rate to 1.0 ...
            self.applyRate(after: 0.3)  // ... so put ours back once playback has started
            promise.resolve(nil)
          }
        }
      }
    }

    AsyncFunction("pause") {
      self.player.pause()
    }.runOnQueue(.main)

    AsyncFunction("resume") {
      self.startObserving()
      self.player.play()
      self.applyRate(after: 0.3)
    }.runOnQueue(.main)

    AsyncFunction("skipToNext") {
      self.player.skipToNextItem()
      self.applyRate(after: 0.3)
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      self.player.stop()
    }.runOnQueue(.main)

    /// Playback speed multiplier: 1.05 = 5% faster = BPM x 1.05. Clamped to 0.5-2.0.
    AsyncFunction("setRate") { (rate: Double) -> [String: Any] in
      self.desiredRate = Float(min(max(rate, 0.5), 2.0))
      self.lastRateApply = Date()
      let p = self.player
      if p.playbackState == .playing {
        p.currentPlaybackRate = self.desiredRate
      }
      return ["desiredRate": Double(self.desiredRate), "rate": Double(p.currentPlaybackRate)]
    }.runOnQueue(.main)

    /// "app" (default) plays inside this app; "system" drives the Music app (keeps playing
    /// when this app is closed). Useful to test which one honors speed changes on an iOS version.
    AsyncFunction("setPlayerKind") { (kind: String) in
      guard kind == "app" || kind == "system", kind != self.playerKind else { return }
      self.player.pause()
      self.stopObserving()
      self.playerKind = kind
      self.rateResets = 0
      self.startObserving()
    }.runOnQueue(.main)

    /// Keep the screen from locking. The JS that follows the heart rate only runs while the app
    /// is on screen (the music itself keeps playing either way).
    AsyncFunction("setKeepScreenOn") { (on: Bool) in
      UIApplication.shared.isIdleTimerDisabled = on
    }.runOnQueue(.main)

    /// Current song, position, speed. Poll about once a second.
    AsyncFunction("getState") { () -> [String: Any] in
      let p = self.player
      let playing = p.playbackState == .playing
      var rate = p.currentPlaybackRate
      // Watchdog: iOS sometimes snaps the rate back to 1.0. Put it back and count it, but
      // give a fresh play/skip/setRate a moment to settle before calling it a reset.
      if playing && abs(rate - self.desiredRate) > 0.001
        && Date().timeIntervalSince(self.lastRateApply) > 1.5
      {
        self.rateResets += 1
        p.currentPlaybackRate = self.desiredRate
        self.lastRateApply = Date()
        rate = p.currentPlaybackRate
      }
      let position = p.currentPlaybackTime
      var state: [String: Any] = [
        "state": Self.stateName(p.playbackState),
        "positionS": position.isFinite ? position : 0,
        "rate": Double(rate),
        "desiredRate": Double(self.desiredRate),
        "rateResets": self.rateResets,
        "playerKind": self.playerKind,
      ]
      if let item = p.nowPlayingItem {
        var song = Self.serialize(item)
        song["artworkUri"] = Self.artworkUri(for: item)
        state["song"] = song
      }
      return state
    }.runOnQueue(.main)
  }

  // -------------------------------------------------------------------- rate + notifications

  private func applyRate(after delay: Double) {
    lastRateApply = Date()
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      let p = self.player
      guard p.playbackState == .playing else { return }
      if abs(p.currentPlaybackRate - self.desiredRate) > 0.001 {
        p.currentPlaybackRate = self.desiredRate
      }
      self.lastRateApply = Date()
    }
  }

  private func startObserving() {
    let p = player
    guard observedPlayer !== p else { return }
    stopObserving()
    observedPlayer = p
    p.beginGeneratingPlaybackNotifications()
    let center = NotificationCenter.default
    for name in [
      Notification.Name.MPMusicPlayerControllerNowPlayingItemDidChange,
      Notification.Name.MPMusicPlayerControllerPlaybackStateDidChange,
    ] {
      observers.append(
        center.addObserver(forName: name, object: p, queue: .main) { [weak self] _ in
          guard let self = self else { return }
          self.applyRate(after: 0.3)
          self.sendEvent("onPlaybackChange", [
            "state": Self.stateName(p.playbackState),
            "songId": p.nowPlayingItem.map { String($0.persistentID) },
          ])
        })
    }
  }

  private func stopObserving() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
    observedPlayer?.endGeneratingPlaybackNotifications()
    observedPlayer = nil
  }

  // -------------------------------------------------------------------- helpers

  private static func item(withId id: String) -> MPMediaItem? {
    guard let pid = UInt64(id) else { return nil }
    let query = MPMediaQuery.songs()
    query.addFilterPredicate(
      MPMediaPropertyPredicate(
        value: NSNumber(value: pid), forProperty: MPMediaItemPropertyPersistentID))
    return query.items?.first
  }

  private static func serialize(_ item: MPMediaItem) -> [String: Any] {
    [
      // persistentID is a UInt64, too big for a JS number: send it as a string
      "id": String(item.persistentID),
      "title": item.title ?? "",
      "artist": item.artist ?? "",
      "album": item.albumTitle ?? "",
      "durationS": item.playbackDuration,
      "libraryBpm": item.beatsPerMinute,  // 0 when the file has no BPM tag (usual)
      "isCloud": item.isCloudItem,
      "isProtected": item.hasProtectedAsset,
    ]
  }

  /// The cover as a file the JS side can show. Saved once per song (getState runs every second).
  private static func artworkUri(for item: MPMediaItem) -> String? {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("apple-music-art-\(item.persistentID).jpg")
    if FileManager.default.fileExists(atPath: url.path) {
      return url.absoluteString
    }
    guard let image = item.artwork?.image(at: CGSize(width: 300, height: 300)),
      let data = image.jpegData(compressionQuality: 0.8),
      (try? data.write(to: url)) != nil
    else { return nil }
    return url.absoluteString
  }

  private static func statusName(_ status: MPMediaLibraryAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
  }

  private static func stateName(_ state: MPMusicPlaybackState) -> String {
    switch state {
    case .playing: return "playing"
    case .paused: return "paused"
    case .stopped: return "stopped"
    case .interrupted: return "interrupted"
    case .seekingForward, .seekingBackward: return "seeking"
    @unknown default: return "unknown"
    }
  }
}

internal final class NotAuthorizedException: Exception, @unchecked Sendable {
  override var reason: String {
    "Apple Music access isn't allowed yet. Call requestAuthorization() first, or allow it in Settings > Privacy & Security > Media & Apple Music."
  }
}
