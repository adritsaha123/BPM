import Constants, { ExecutionEnvironment } from "expo-constants";

/**
 * True when running inside the Expo Go app.
 * Expo Go can't load custom native modules (Bluetooth via react-native-ble-plx)
 * and doesn't support background location on iOS, so those paths fall back:
 *   - Whoop HR → simulated HR
 *   - background GPS task → foreground GPS (keep the screen on)
 */
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
