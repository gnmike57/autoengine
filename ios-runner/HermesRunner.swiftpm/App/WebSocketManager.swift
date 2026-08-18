import Foundation
import Combine

class WebSocketManager: ObservableObject {
    static let shared = WebSocketManager()
    
    // Change this to your Mac's IP if running on a physical device on the same WiFi
    let serverAddress = "127.0.0.1:3011" 
    
    @Published var isConnected = false
    @Published var logs: [ChatLog] = []
    @Published var detections: [BotDetectionEvent] = []
    @Published var screenshots: [HermesScreenshot] = []
    
    private var webSocketTask: URLSessionWebSocketTask?
    
    private init() {
        connect()
    }
    
    func connect() {
        guard let url = URL(string: "ws://\(serverAddress)") else { return }
        let request = URLRequest(url: url)
        webSocketTask = URLSession.shared.webSocketTask(with: request)
        webSocketTask?.resume()
        receiveMessage()
        
        DispatchQueue.main.async {
            self.isConnected = true
            self.addLog("Connected to Hermes Core: ws://\(self.serverAddress)")
        }
    }
    
    func sendCommand(action: String, payload: [String: Any]? = nil) {
        var commandDict: [String: Any] = ["action": action]
        if let payload = payload {
            for (k, v) in payload { commandDict[k] = v }
        }
        let msg: [String: Any] = [
            "type": "hermes-command",
            "data": commandDict
        ]
        
        guard let data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        let message = URLSessionWebSocketTask.Message.data(data)
        webSocketTask?.send(message) { error in
            if let error = error {
                print("Failed to send command: \(error)")
            }
        }
        self.addLog("Dispatched Command: \(action)")
    }
    
    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .failure(let error):
                print("WebSocket error: \(error)")
                DispatchQueue.main.async {
                    self?.isConnected = false
                    self?.addLog("Disconnected.", isError: true)
                }
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleIncomingText(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self?.handleIncomingText(text)
                    }
                @unknown default:
                    break
                }
                // Loop to continue receiving
                self?.receiveMessage()
            }
        }
    }
    
    private func handleIncomingText(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }
        
        DispatchQueue.main.async {
            switch type {
            case "log":
                if let payload = json["data"] as? [String: Any],
                   let msg = payload["msg"] as? String {
                    self.addLog(msg)
                }
            case "bot_detection_event":
                if let payload = json["data"] as? [String: Any] {
                    let event = BotDetectionEvent(
                        email: payload["email"] as? String ?? "Unknown",
                        signal: payload["signal"] as? String ?? "Unknown",
                        source: payload["source"] as? String ?? "Unknown",
                        url: payload["url"] as? String ?? "Unknown"
                    )
                    self.detections.insert(event, at: 0)
                    self.addLog("🚨 Bot Detection: \(event.signal) on \(event.email)", isError: true)
                }
            case "screenshot":
                if let payload = json["data"] as? [String: Any],
                   let email = payload["email"] as? String,
                   let target = payload["target"] as? String,
                   let relativePath = payload["relativePath"] as? String {
                    let screenshot = HermesScreenshot(email: email, target: target, relativePath: relativePath)
                    self.screenshots.insert(screenshot, at: 0)
                    if self.screenshots.count > 100 { self.screenshots.removeLast() }
                }
            default:
                break
            }
        }
    }
    
    private func addLog(_ text: String, isError: Bool = false) {
        let log = ChatLog(text: text, isError: isError)
        logs.append(log)
        if logs.count > 500 { logs.removeFirst() }
    }
}
