import { InternalTools } from '@rndevtools/core';
import { setDevtoolsAuthorization } from '@rndevtools/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { connectToDesktop } from '@/devtools/desktop';
import { createDemoDevtools } from '@/devtools/plugins';

const queryClient = new QueryClient();

export function App() {
	const { plugins, instrumentedFetch } = useMemo(
		() => createDemoDevtools(queryClient),
		[],
	);

	useEffect(() => {
		// Privileged actions stay refused until the host grants authorization.
		// A real app gates this on staff status and binds it to its auth source.
		setDevtoolsAuthorization({ enabled: __DEV__, ownerId: 'demo-user' });

		// One instrumented request so the network panel has something to show.
		void instrumentedFetch('https://api.example.com/health').catch(() => {
			// A failed demo request is still a captured request.
		});

		const desktop = connectToDesktop();
		return () => desktop?.stop();
	}, [instrumentedFetch]);

	return (
		<GestureHandlerRootView style={styles.root}>
			<SafeAreaProvider>
				<QueryClientProvider client={queryClient}>
					<View style={styles.content}>
						<Text style={styles.title}>RN Devtools demo</Text>
						<Text style={styles.body}>
							Shake the device or tap the floating launcher to open the panels.
						</Text>
					</View>
					{/*
					  `enabled` is the single switch. Collectors follow it, not panel
					  visibility, so traffic is captured before the panel is opened.
					*/}
					<InternalTools enabled={__DEV__} plugins={plugins} />
				</QueryClientProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
	content: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		gap: 8,
		padding: 24,
	},
	title: { fontSize: 20, fontWeight: '600' },
	body: { fontSize: 14, opacity: 0.7, textAlign: 'center' },
});
