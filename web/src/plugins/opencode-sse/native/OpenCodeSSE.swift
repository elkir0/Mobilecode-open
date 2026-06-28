// SPDX-License-Identifier: Apache-2.0
// Based on opencode-remote-android by giuliastro (Apache-2.0). Modified for iOS, 2026.
import Foundation
import Capacitor

@objc(OpenCodeSSE)
public class OpenCodeSSE: CAPPlugin {
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var buffer = ""
    private var impl: OpenCodeSSEImpl?

    @objc func connect(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.reject("invalid url"); return
        }
        DispatchQueue.main.async { self.notifyListeners("opencode:state", data: ["state": "connecting"]) }

        var request = URLRequest(url: url)
        if let auth = call.getString("basicAuth") { request.setValue(auth, forHTTPHeaderField: "Authorization") }
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        let impl = OpenCodeSSEImpl(plugin: self)
        self.impl = impl
        let s = URLSession(configuration: .default, delegate: impl, delegateQueue: nil)
        self.session = s
        self.task = s.dataTask(with: request)
        self.task?.resume()
        call.resolve()
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        buffer = ""
        call.resolve()
    }

    func onState(_ state: String, error: String? = nil) {
        var data: [String: Any] = ["state": state]
        if let error { data["error"] = error }
        DispatchQueue.main.async { self.notifyListeners("opencode:state", data: data) }
    }

    func feed(_ chunk: String) {
        buffer += chunk
        while let sep = buffer.range(of: "\n\n") {
            let block = String(buffer[..<sep.lowerBound])
            buffer.removeSubrange(buffer.startIndex...sep.upperBound)
            if let event = OpenCodeSSE.parse(block: block) {
                DispatchQueue.main.async { self.notifyListeners("opencode:event", data: ["type": event.type, "data": event.data]) }
            }
        }
    }

    struct ParsedEvent { let type: String; let data: Any }
    static func parse(block: String) -> ParsedEvent? {
        var type = "message"
        var dataLines: [String] = []
        for line in block.split(separator: "\n") {
            if line.hasPrefix("event:") { type = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
            else if line.hasPrefix("data:") { dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
        }
        guard !dataLines.isEmpty else { return nil }
        let dataStr = dataLines.joined(separator: "\n")
        if let d = dataStr.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: d) {
            return ParsedEvent(type: type, data: json)
        }
        return ParsedEvent(type: type, data: dataStr)
    }
}

private class OpenCodeSSEImpl: NSObject, URLSessionDataDelegate {
    weak var plugin: OpenCodeSSE?
    init(plugin: OpenCodeSSE) { self.plugin = plugin }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if let chunk = String(data: data, encoding: .utf8) { plugin?.feed(chunk) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse, http.statusCode == 200 {
            plugin?.onState("connected")
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { plugin?.onState("error", error: error.localizedDescription) }
        else { plugin?.onState("offline") }
    }
}
