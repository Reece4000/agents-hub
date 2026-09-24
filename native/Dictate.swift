import Foundation
import Speech
import AVFoundation

func emit(_ type: String, _ value: String = "") {
    let payload = ["type": type, "text": value]
    if let data = try? JSONSerialization.data(withJSONObject: payload), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

let speechPermission = DispatchSemaphore(value: 0)
var speechStatus: SFSpeechRecognizerAuthorizationStatus = .notDetermined
SFSpeechRecognizer.requestAuthorization { status in speechStatus = status; speechPermission.signal() }
_ = speechPermission.wait(timeout: .now() + 30)
guard speechStatus == .authorized else { emit("error", "Speech recognition permission was denied."); exit(1) }

let microphonePermission = DispatchSemaphore(value: 0)
var microphoneAllowed = false
AVCaptureDevice.requestAccess(for: .audio) { allowed in microphoneAllowed = allowed; microphonePermission.signal() }
_ = microphonePermission.wait(timeout: .now() + 30)
guard microphoneAllowed else { emit("error", "Microphone permission was denied."); exit(1) }

guard let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
    emit("error", "On-device speech recognition is unavailable for this language.")
    exit(1)
}

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0, format.channelCount > 0 else { emit("error", "No microphone input is available."); exit(1) }
let request = SFSpeechAudioBufferRecognitionRequest()
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = true
var latest = ""
var finished = false
func finish(_ value: String) {
    if finished { return }
    finished = true
    emit("final", value)
    exit(0)
}

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        latest = result.bestTranscription.formattedString
        if result.isFinal { finish(latest) }
    }
    if let error = error, !finished { emit("error", error.localizedDescription); exit(1) }
}
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
do { engine.prepare(); try engine.start() }
catch { input.removeTap(onBus: 0); task.cancel(); emit("error", "Could not start microphone: \(error.localizedDescription)"); exit(1) }
emit("ready")

DispatchQueue.global().async {
    while let command = readLine() {
        if command == "stop" {
            engine.stop()
            input.removeTap(onBus: 0)
            request.endAudio()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish(latest) }
            return
        }
        if command == "cancel" { task.cancel(); engine.stop(); exit(0) }
    }
    task.cancel()
    engine.stop()
    exit(0)
}
RunLoop.main.run()
