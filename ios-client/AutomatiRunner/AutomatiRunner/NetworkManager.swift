import Foundation
import SwiftUI
import Combine

class NetworkManager: ObservableObject {
    static let shared = NetworkManager()
    
    @AppStorage("serverIP") var serverIP: String = "192.168.1.5:3000"
    @AppStorage("mobileAPIKey") var mobileAPIKey: String = ""
    
    @Published var isConnected = false
    @Published var engineIsRunning = false
    @Published var activeBackend = "stealth"
    @Published var totalRows = 0
    
    private var webSocketTask: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)
    
    func connect() {
        guard !serverIP.isEmpty, !mobileAPIKey.isEmpty else { return }
        let urlString = "ws://\\(serverIP)/events?token=\\(mobileAPIKey)"
        guard let url = URL(string: urlString) else { return }
        
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        receiveMessage()
        
        DispatchQueue.main.async {
            self.isConnected = true
        }
    }
    
    func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        DispatchQueue.main.async {
            self.isConnected = false
        }
    }
    
    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .failure(let error):
                print("WebSocket receive error: \\(error)")
                DispatchQueue.main.async {
                    self?.isConnected = false
                }
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleIncomingMessage(text)
                case .data(_):
                    break
                @unknown default:
                    break
                }
                self?.receiveMessage()
            }
        }
    }
    
    private func handleIncomingMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }
        
        DispatchQueue.main.async {
            if type == "state" {
                if let state = json["state"] as? [String: Any] {
                    self.engineIsRunning = state["isRunning"] as? Bool ?? false
                    
                    if let config = state["config"] as? [String: Any] {
                        self.activeBackend = config["backend"] as? String ?? "stealth"
                    }
                    if let rows = state["rows"] as? [[String: Any]] {
                        self.totalRows = rows.count
                    }
                }
            }
        }
    }
    
    func uploadCredentials(csvText: String, completion: @escaping (Bool, String) -> Void) {
        guard !serverIP.isEmpty, !mobileAPIKey.isEmpty else {
            completion(false, "Server IP or API Key missing")
            return
        }
        
        let urlString = "http://\\(serverIP)/api/credentials/text-paste"
        guard let url = URL(string: urlString) else { return }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \\(mobileAPIKey)", forHTTPHeaderField: "Authorization")
        request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        request.httpBody = csvText.data(using: .utf8)
        
        session.dataTask(with: request) { data, response, error in
            if let error = error {
                DispatchQueue.main.async { completion(false, error.localizedDescription) }
                return
            }
            if let httpRes = response as? HTTPURLResponse, httpRes.statusCode == 200 {
                DispatchQueue.main.async { completion(true, "Success") }
            } else {
                DispatchQueue.main.async { completion(false, "Server rejected upload") }
            }
        }.resume()
    }
}
