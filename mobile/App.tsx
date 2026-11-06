import { StatusBar } from "expo-status-bar";

import AIDemoScreen from "./src/screens/AIDemoScreen";

export default function App() {
  return (
    <>
      <AIDemoScreen />
      <StatusBar style="dark" />
    </>
  );
}
