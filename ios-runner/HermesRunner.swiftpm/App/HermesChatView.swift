import SwiftUI

struct HermesChatView: View {
    @EnvironmentObject var wsManager: WebSocketManager
    
    var body: some View {
        NavigationView {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(wsManager.logs) { log in
                            HStack(alignment: .top) {
                                Text(log.timestamp, style: .time)
                                    .font(.caption2)
                                    .foregroundColor(.gray)
                                
                                Text(log.text)
                                    .font(.system(.subheadline, design: .monospaced))
                                    .foregroundColor(log.isError ? .red : .primary)
                            }
                            .id(log.id)
                        }
                    }
                    .padding()
                }
                .onChange(of: wsManager.logs.count) { _ in
                    if let last = wsManager.logs.last {
                        withAnimation {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
            .navigationTitle("AI Feed & Bot Detections")
        }
    }
}
