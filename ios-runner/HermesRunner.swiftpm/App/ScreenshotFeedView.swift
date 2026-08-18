import SwiftUI

struct ScreenshotFeedView: View {
    @EnvironmentObject var wsManager: WebSocketManager
    
    let columns = [GridItem(.flexible()), GridItem(.flexible())]
    
    var body: some View {
        NavigationView {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(wsManager.screenshots) { screenshot in
                        VStack {
                            let urlString = "http://\(wsManager.serverAddress.split(separator: ":").first ?? "127.0.0.1"):3011/screenshots/\(screenshot.relativePath)"
                            if let url = URL(string: urlString) {
                                AsyncImage(url: url) { phase in
                                    if let image = phase.image {
                                        image
                                            .resizable()
                                            .scaledToFit()
                                            .cornerRadius(8)
                                    } else if phase.error != nil {
                                        Color.red.opacity(0.3)
                                            .overlay(Image(systemName: "exclamationmark.triangle"))
                                    } else {
                                        Color.gray.opacity(0.3)
                                            .overlay(ProgressView())
                                    }
                                }
                                .frame(height: 150)
                            }
                            
                            Text(screenshot.email)
                                .font(.caption)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Text(screenshot.target)
                                .font(.caption2)
                                .foregroundColor(.gray)
                        }
                        .padding(8)
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(12)
                    }
                }
                .padding()
            }
            .navigationTitle("Live Vision Feed")
        }
    }
}
