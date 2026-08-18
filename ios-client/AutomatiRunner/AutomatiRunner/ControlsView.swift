import SwiftUI

struct ControlsView: View {
    @EnvironmentObject var network: NetworkManager
    
    var body: some View {
        NavigationView {
            ZStack {
                Color.black.ignoresSafeArea()
                
                VStack(spacing: 30) {
                    Text("ENGINE CONTROLS")
                        .foregroundColor(.green)
                        .font(.system(size: 16, weight: .bold, design: .monospaced))
                    
                    Text("These controls require WebSocket connection.")
                        .foregroundColor(.gray)
                        .font(.system(size: 12, design: .monospaced))
                        .multilineTextAlignment(.center)
                    
                    Spacer()
                }
                .padding()
            }
            .navigationTitle("Controls")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
