Pod::Spec.new do |s|
  s.name           = 'AppleMusic'
  s.version        = '1.0.0'
  s.summary        = 'Apple Music library playback with speed (BPM) control'
  s.description    = 'Plays the user\'s Apple Music library with MPMusicPlayerController and changes playback rate.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'MediaPlayer'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
