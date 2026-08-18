import SwiftUI

@main
struct AutomatiRunnerApp: App {
    @StateObject private var networkManager = NetworkManager.shared
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(networkManager)
                .preferredColorScheme(.dark)
        }
    }
}
