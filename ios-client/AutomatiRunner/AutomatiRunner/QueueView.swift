import SwiftUI

struct QueueView: View {
    @EnvironmentObject var network: NetworkManager
    @State private var pasteText: String = ""
    @State private var statusMessage: String = ""
    
    var body: some View {
        NavigationView {
            ZStack {
                Color.black.ignoresSafeArea()
                
                VStack(spacing: 20) {
                    Text("INJECT CREDENTIALS")
                        .foregroundColor(.green)
                        .font(.system(size: 16, weight: .bold, design: .monospaced))
                    
                    TextEditor(text: $pasteText)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundColor(.green)
                        .padding()
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(10)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(Color.green.opacity(0.3), lineWidth: 1)
                        )
                    
                    Button(action: {
                        upload()
                    }) {
                        Text("PUSH TO RUNNER")
                            .font(.system(size: 16, weight: .bold, design: .monospaced))
                            .foregroundColor(.black)
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(Color.green)
                            .cornerRadius(10)
                    }
                    
                    if !statusMessage.isEmpty {
                        Text(statusMessage)
                            .foregroundColor(.white)
                            .font(.system(size: 12, design: .monospaced))
                    }
                }
                .padding()
            }
            .navigationTitle("Queue")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
    
    private func upload() {
        guard !pasteText.isEmpty else { return }
        statusMessage = "Pushing..."
        network.uploadCredentials(csvText: pasteText) { success, msg in
            if success {
                statusMessage = "Success! Credentials queued."
                pasteText = ""
            } else {
                statusMessage = "Error: \\(msg)"
            }
        }
    }
}
