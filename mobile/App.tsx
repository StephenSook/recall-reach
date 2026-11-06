// A shop owner's phone: the deployed queue in a web view, so it can't drift from the site, plus the one thing a page
// can't do, which is buzz when a card lands. Families never install anything. Their page is the site's.
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { type ComponentType, type RefAttributes, useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, Text } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewProps } from "react-native-webview";
import { QUEUE, staysInApp, tokenScript, urlFromPush } from "./links";

// This package's class types don't fit React 19's JSX types yet. It runs fine, so only the type is restated.
const Web = WebView as unknown as ComponentType<WebViewProps & RefAttributes<WebView>>;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** Null when this phone can't take pushes: a simulator, a refusal, or an Android build with no push service set up. */
async function pushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("cards", { name: "New cards", importance: Notifications.AndroidImportance.HIGH });
  const asked = await Notifications.requestPermissionsAsync();
  if (!asked.granted) return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

export default function App() {
  const web = useRef<WebView>(null);
  const token = useRef<string | null>(null);
  const [uri, setUri] = useState(QUEUE);
  const [offline, setOffline] = useState(false);

  const handToPage = () => {
    if (token.current) web.current?.injectJavaScript(tokenScript(token.current));
  };

  useEffect(() => {
    pushToken()
      .then((t) => {
        token.current = t;
        handToPage();
      })
      .catch(() => {
        // The queue still works without a buzz.
      });
    const open = (data: unknown) => {
      const target = urlFromPush(data);
      if (target) setUri(target);
    };
    open(Notifications.getLastNotificationResponse()?.notification.request.content.data);
    const tapped = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data));
    return () => tapped.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.page}>
        <StatusBar style="dark" />
        {offline ? (
          <>
            <Text style={styles.line}>The queue could not load. Check your connection.</Text>
            <Pressable accessibilityRole="button" style={styles.button} onPress={() => setOffline(false)}>
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </>
        ) : (
          <Web
            ref={web}
            source={{ uri }}
            originWhitelist={["https://*", "about:*"]}
            sharedCookiesEnabled
            onLoadEnd={handToPage}
            onError={() => setOffline(true)}
            onShouldStartLoadWithRequest={(request) => {
              if (request.isTopFrame === false || staysInApp(request.url)) return true;
              Linking.openURL(request.url).catch(() => {});
              return false;
            }}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#ffffff" },
  line: { margin: 24, fontSize: 18, color: "#000000" },
  button: { marginHorizontal: 24, padding: 16, backgroundColor: "#000000", alignItems: "center" },
  buttonText: { fontSize: 18, color: "#ffffff" },
});
