import SwiftUI

struct ContentView: View {
    @EnvironmentObject var networkManager: NetworkManager
    
    var body: some View {
        TabView {
            DashboardView()
                .tabItem {
                    Label("Dashboard", systemImage: "chart.xyaxis.line")
                }
            
            QueueView()
                .tabItem {
                    Label("Queue", systemImage: "list.bullet.rectangle.portrait")
                }
            
            ControlsView()
                .tabItem {
                    Label("Controls", systemImage: "slider.horizontal.3")
                }
            
            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
        .tint(.green) // Hacker green tint
    }
}
