# AutomatiRunner iOS Client

This directory contains the Swift source files for the iOS Runner application. 
Because Xcode projects require specific internal structure (`.xcodeproj` bundles and `pbxproj` metadata), you will need to quickly scaffold an empty project in Xcode and drag these files in:

## Setup Instructions

1. Open **Xcode** on your Mac.
2. Select **File > New > Project**.
3. Choose **iOS > App** and click Next.
4. Name the project **AutomatiRunner**, ensure the interface is **SwiftUI**, and click Next.
5. Save the project to this `ios-client` folder (or overwrite the existing one).
6. Delete the default `ContentView.swift` and `AutomatiRunnerApp.swift` that Xcode generated.
7. Drag and drop all the `.swift` files provided in this directory into your Xcode project navigator.
8. Set your server IP address and `MOBILE_API_KEY` (from your Mac terminal logs) into the Settings tab of the App.
9. Click the **Play** button (Cmd+R) in Xcode to build and run it on your iOS Simulator or physical iPhone!
