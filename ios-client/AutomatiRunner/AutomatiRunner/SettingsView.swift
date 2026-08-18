import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var network: NetworkManager
    
    var body: some View {
        NavigationView {
            ZStack {
                Color.black.ignoresSafeArea()
                
                VStack(alignment: .leading, spacing: 20) {
                    Text("RUNNER SETTINGS")
                        .foregroundColor(.green)
                        .font(.system(size: 16, weight: .bold, design: .monospaced))
                    
                    VStack(alignment: .leading) {
                        Text("SERVER IP:PORT")
                            .foregroundColor(.gray)
                            .font(.system(size: 12, design: .monospaced))
                        TextField("e.g. 192.168.1.5:3000", text: $network.serverIP)
                            .textFieldStyle(PlainTextFieldStyle())
                            .foregroundColor(.white)
                            .padding()
                            .background(Color.gray.opacity(0.2))
                            .cornerRadius(8)
                    }
                    
                    VStack(alignment: .leading) {
                        Text("MOBILE API KEY")
                            .foregroundColor(.gray)
                            .font(.system(size: 12, design: .monospaced))
                        TextField("Paste Bearer Key", text: $network.mobileAPIKey)
                            .textFieldStyle(PlainTextFieldStyle())
                            .foregroundColor(.white)
                            .padding()
                            .background(Color.gray.opacity(0.2))
                            .cornerRadius(8)
                    }
                    
                    Spacer()
                }
                .padding()
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
