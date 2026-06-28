// SPDX-License-Identifier: Apache-2.0
// On-device speech-to-text (SFSpeechRecognizer) for the chat composer.
// Streams partial transcripts via the "partial" event; emits a final
// "result" event (finished: true) when recognition ends.
import Foundation
import Capacitor
import Speech
import AVFoundation

@objc(Speech)
public class Speech: CAPPlugin {
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    private var locale: Locale?
    private var isAuthorized = false

    // MARK: - Plugin methods

    @objc func isSupported(_ call: CAPPluginCall) {
        // SFSpeechRecognizer.isAvailable is an instance property; we need a
        // recognizer instance to query it. A non-nil recognizer also implies
        // the locale is supported on this device.
        let recognizer = self.recognizer(for: call.getString("locale").map { Locale(identifier: $0) })
        let supported = recognizer != nil && (recognizer?.isAvailable ?? false)
        DispatchQueue.main.async {
            call.resolve(["value": supported])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let localeID = call.getString("locale")
        let locale = localeID.flatMap { Locale(identifier: $0) }

        // 1) Authorization. Request both speech + mic permission up front.
        SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
            guard let self = self else { return }
            guard speechStatus == .authorized else {
                call.reject("speech recognition not authorized")
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
                guard micGranted else {
                    call.reject("microphone permission denied")
                    return
                }
                DispatchQueue.main.async {
                    self.isAuthorized = true
                    self.beginRecognition(locale: locale, call: call)
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endRecognition()
            call.resolve()
        }
    }

    // MARK: - Recognition lifecycle

    private func beginRecognition(locale: Locale?, call: CAPPluginCall) {
        // Tear down any previous run first.
        endRecognition()

        guard let recognizer = self.recognizer(for: locale) else {
            call.reject("speech recognizer unavailable for this locale")
            return
        }
        self.recognizer = recognizer
        guard recognizer.isAvailable else {
            call.reject("speech recognizer not available")
            return
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            call.reject("audio session error: \(error.localizedDescription)")
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Keep recognition on-device when supported (iOS 13+).
        if #available(iOS 13, *) {
            request.requiresOnDeviceRecognition = false
        }
        self.request = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }

        let task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                DispatchQueue.main.async {
                    self.notifyListeners("partial", data: ["text": text])
                    if isFinal {
                        self.notifyListeners("result", data: ["text": text, "finished": true])
                    }
                }
            }
            if error != nil {
                // Recognition bailed (timeout, etc.). Surface a finished result
                // so the JS side can settle, then stop the engine.
                DispatchQueue.main.async {
                    self.notifyListeners("result", data: ["text": "", "finished": true])
                    self.endRecognition()
                }
            }
        }
        self.task = task

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            endRecognition()
            call.reject("audio engine error: \(error.localizedDescription)")
            return
        }

        call.resolve()
    }

    private func endRecognition() {
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // Resolve a recognizer for the requested locale (or the default).
    private func recognizer(for locale: Locale?) -> SFSpeechRecognizer? {
        if let locale = locale ?? self.locale {
            return SFSpeechRecognizer(locale: locale)
        }
        return SFSpeechRecognizer()
    }
}
