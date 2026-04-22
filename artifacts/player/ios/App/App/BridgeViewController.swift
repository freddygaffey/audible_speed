import Capacitor

class BridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        let argsJoined = CommandLine.arguments.joined(separator: " ")
        UserDefaults.standard.set(argsJoined, forKey: "SpeedBridgeArgs")
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "SpeedBridgeDidLoadTs")
        UserDefaults.standard.synchronize()
        let nativeAudio = NativeAudioPlugin()
        bridge?.registerPluginInstance(nativeAudio)
        NSLog("NativeAudio plugin registered")
        print("NativeAudio plugin registered")
        if CommandLine.arguments.contains("--speed-autotest-native-audio") {
            NSLog("SPEED_AUTOTEST_NATIVE_AUDIO trigger detected")
            print("SPEED_AUTOTEST_NATIVE_AUDIO trigger detected")
            UserDefaults.standard.set(
                "{\"state\":\"requested\",\"results\":[]}",
                forKey: "SpeedAutotestReportJson"
            )
            UserDefaults.standard.synchronize()
            nativeAudio.runAutotestMatrix()
        }
    }
}
