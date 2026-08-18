import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var network: NetworkManager
    
    var body: some View {
        NavigationView {
            ZStack {
                Color.black.ignoresSafeArea()
                
                VStack(spacing: 20) {
                    HStack {
                        Circle()
                            .fill(network.isConnected ? Color.green : Color.red)
                            .frame(width: 12, height: 12)
                        Text(network.isConnected ? "Connected" : "Disconnected")
                            .foregroundColor(.green)
                            .font(.system(size: 14, weight: .bold, design: .monospaced))
                    }
                    
                    VStack(alignment: .leading, spacing: 10) {
                        Text("SYSTEM METRICS")
                            .foregroundColor(.gray)
                            .font(.system(size: 12, weight: .bold, design: .monospaced))
                        
                        MetricRow(label: "Engine Status", value: network.engineIsRunning ? "RUNNING" : "STOPPED")
                        MetricRow(label: "Active Backend", value: network.activeBackend.uppercased())
                        MetricRow(label: "Queue Size", value: "\\(network.totalRows)")
                    }
                    .padding()
                    .background(Color.gray.opacity(0.1))
                    .cornerRadius(10)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(Color.green.opacity(0.3), lineWidth: 1)
                    )
                    
                    Spacer()
                }
                .padding()
            }
            .navigationTitle("Dashboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        if network.isConnected {
                            network.disconnect()
                        } else {
                            network.connect()
                        }
                    }) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .foregroundColor(.green)
                    }
                }
            }
        }
    }
}

struct MetricRow: View {
    let label: String
    let value: String
    
    var body: some View {
        HStack {
            Text(label)
                .foregroundColor(.green)
                .font(.system(size: 14, design: .monospaced))
            Spacer()
            Text(value)
                .foregroundColor(.white)
                .font(.system(size: 14, weight: .bold, design: .monospaced))
        }
    }
}
