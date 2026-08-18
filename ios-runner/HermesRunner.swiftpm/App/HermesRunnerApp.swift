import SwiftUI

@main
struct HermesRunnerApp: App {
    @StateObject private var wsManager = WebSocketManager.shared
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(wsManager)
                .preferredColorScheme(.dark)
        }
    }
}

struct ContentView: View {
    var body: some View {
        TabView {
            DashboardView()
                .tabItem {
                    Label("Dashboard", systemImage: "terminal.fill")
                }
            
            HermesChatView()
                .tabItem {
                    Label("Hermes AI", systemImage: "cpu")
                }
                
            ScreenshotFeedView()
                .tabItem {
                    Label("Live Feed", systemImage: "eye.fill")
                }
        }
        .accentColor(.cyan)
    }
}
