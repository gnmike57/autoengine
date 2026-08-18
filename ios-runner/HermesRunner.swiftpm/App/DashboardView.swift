import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var wsManager: WebSocketManager
    
    @State private var newGoal: String = ""
    @State private var csvText: String = ""
    @State private var queueStatus: String = ""
    
    var body: some View {
        NavigationView {
            Form {
                Section(header: Text("Connection Status")) {
                    HStack {
                        Circle()
                            .fill(wsManager.isConnected ? Color.green : Color.red)
                            .frame(width: 10, height: 10)
                        Text(wsManager.isConnected ? "Connected to Hermes Core" : "Disconnected")
                    }
                }
                
                Section(header: Text("AI Directives")) {
                    TextField("Enter new Core Goal for AI", text: $newGoal)
                    Button("Set Core Goal") {
                        wsManager.sendCommand(action: "set_goal", payload: ["goal": newGoal])
                        newGoal = ""
                    }
                    .disabled(newGoal.isEmpty || !wsManager.isConnected)
                    
                    Button("Force AI Optimization Cycle") {
                        wsManager.sendCommand(action: "force_cycle")
                    }
                    .foregroundColor(.orange)
                    .disabled(!wsManager.isConnected)
                }
                
                Section(header: Text("Queue Credentials (CSV)")) {
                    TextEditor(text: $csvText)
                        .frame(height: 100)
                        .font(.system(.footnote, design: .monospaced))
                    
                    Button("Queue via API") {
                        submitCsv()
                    }
                    .disabled(csvText.isEmpty)
                    
                    if !queueStatus.isEmpty {
                        Text(queueStatus)
                            .font(.caption)
                            .foregroundColor(.gray)
                    }
                }
            }
            .navigationTitle("Command Center")
        }
    }
    
    private func submitCsv() {
        guard let url = URL(string: "http://\(wsManager.serverAddress.split(separator: ":").first ?? "127.0.0.1"):3011/api/credentials/text-paste") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        
        request.httpBody = csvText.data(using: .utf8)
        
        URLSession.shared.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self.queueStatus = "Error: \(error.localizedDescription)"
                    return
                }
                self.queueStatus = "Successfully queued credentials."
                self.csvText = ""
            }
        }.resume()
    }
}
