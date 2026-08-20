import {
	type IconName,
	Host as UniversalHost,
	Icon as UniversalIcon,
} from '@expo/ui';
import { Host, Image } from '@expo/ui/swift-ui';
import { frame } from '@expo/ui/swift-ui/modifiers';
import {
	type ColorValue,
	Platform,
	PlatformColor,
	StyleSheet,
	View,
} from 'react-native';
import type { DevToolsSystemImage } from '../types';

type SystemIconProps = {
	systemName: DevToolsSystemImage;
	size?: number;
	color?: ColorValue;
};

const materialIcons = {
	back: UniversalIcon.select({
		ios: 'chevron.left',
		android: import('@expo/material-symbols/chevron_left.xml'),
	}),
	build: UniversalIcon.select({
		ios: 'wrench.and.screwdriver.fill',
		android: import('@expo/material-symbols/build.xml'),
	}),
	check: UniversalIcon.select({
		ios: 'checkmark',
		android: import('@expo/material-symbols/check.xml'),
	}),
	close: UniversalIcon.select({
		ios: 'xmark',
		android: import('@expo/material-symbols/close.xml'),
	}),
	cloud: UniversalIcon.select({
		ios: 'icloud',
		android: import('@expo/material-symbols/cloud.xml'),
	}),
	database: UniversalIcon.select({
		ios: 'externaldrive.fill',
		android: import('@expo/material-symbols/database.xml'),
	}),
	delete: UniversalIcon.select({
		ios: 'trash',
		android: import('@expo/material-symbols/delete.xml'),
	}),
	edit: UniversalIcon.select({
		ios: 'pencil',
		android: import('@expo/material-symbols/edit.xml'),
	}),
	forward: UniversalIcon.select({
		ios: 'chevron.right',
		android: import('@expo/material-symbols/chevron_right.xml'),
	}),
	group: UniversalIcon.select({
		ios: 'person.2.fill',
		android: import('@expo/material-symbols/groups.xml'),
	}),
	hourglass: UniversalIcon.select({
		ios: 'hourglass',
		android: import('@expo/material-symbols/hourglass_empty.xml'),
	}),
	info: UniversalIcon.select({
		ios: 'info.circle',
		android: import('@expo/material-symbols/info.xml'),
	}),
	link: UniversalIcon.select({
		ios: 'link',
		android: import('@expo/material-symbols/link.xml'),
	}),
	location: UniversalIcon.select({
		ios: 'location.fill',
		android: import('@expo/material-symbols/location_on.xml'),
	}),
	message: UniversalIcon.select({
		ios: 'text.bubble.fill',
		android: import('@expo/material-symbols/chat.xml'),
	}),
	more: UniversalIcon.select({
		ios: 'ellipsis.circle',
		android: import('@expo/material-symbols/more_vert.xml'),
	}),
	network: UniversalIcon.select({
		ios: 'network',
		android: import('@expo/material-symbols/network_check.xml'),
	}),
	open: UniversalIcon.select({
		ios: 'arrow.up.forward',
		android: import('@expo/material-symbols/open_in_new.xml'),
	}),
	pause: UniversalIcon.select({
		ios: 'pause.fill',
		android: import('@expo/material-symbols/pause.xml'),
	}),
	person: UniversalIcon.select({
		ios: 'person.crop.circle',
		android: import('@expo/material-symbols/person.xml'),
	}),
	pin: UniversalIcon.select({
		ios: 'pin',
		android: import('@expo/material-symbols/pin.xml'),
	}),
	play: UniversalIcon.select({
		ios: 'play.fill',
		android: import('@expo/material-symbols/play_arrow.xml'),
	}),
	refresh: UniversalIcon.select({
		ios: 'arrow.clockwise',
		android: import('@expo/material-symbols/refresh.xml'),
	}),
	search: UniversalIcon.select({
		ios: 'magnifyingglass',
		android: import('@expo/material-symbols/search.xml'),
	}),
	settings: UniversalIcon.select({
		ios: 'gearshape.2.fill',
		android: import('@expo/material-symbols/settings.xml'),
	}),
	shield: UniversalIcon.select({
		ios: 'lock.shield',
		android: import('@expo/material-symbols/shield_lock.xml'),
	}),
	storage: UniversalIcon.select({
		ios: 'externaldrive.fill',
		android: import('@expo/material-symbols/storage.xml'),
	}),
	timer: UniversalIcon.select({
		ios: 'timer',
		android: import('@expo/material-symbols/timer.xml'),
	}),
	warning: UniversalIcon.select({
		ios: 'exclamationmark.triangle.fill',
		android: import('@expo/material-symbols/warning.xml'),
	}),
	window: UniversalIcon.select({
		ios: 'macwindow',
		android: import('@expo/material-symbols/window.xml'),
	}),
} as const satisfies Record<string, IconName>;

export function universalIconForSystemImage(
	systemName: DevToolsSystemImage,
): IconName {
	if (systemName === 'chevron.left') return materialIcons.back;
	if (systemName === 'chevron.right') return materialIcons.forward;
	if (systemName === 'xmark' || systemName.startsWith('xmark.'))
		return materialIcons.close;
	if (systemName.includes('checkmark')) return materialIcons.check;
	if (systemName.includes('trash')) return materialIcons.delete;
	if (systemName.includes('pencil')) return materialIcons.edit;
	if (systemName.includes('magnifyingglass')) return materialIcons.search;
	if (systemName.includes('person.2')) return materialIcons.group;
	if (systemName.includes('person')) return materialIcons.person;
	if (systemName.includes('bubble')) return materialIcons.message;
	if (systemName.includes('network') || systemName.includes('wifi'))
		return materialIcons.network;
	if (systemName.includes('externaldrive') || systemName.includes('storage'))
		return materialIcons.storage;
	if (systemName.includes('stack') || systemName.includes('database'))
		return materialIcons.database;
	if (systemName.includes('gear')) return materialIcons.settings;
	if (systemName.includes('shield') || systemName.includes('lock'))
		return materialIcons.shield;
	if (systemName.includes('timer') || systemName.includes('clock'))
		return materialIcons.timer;
	if (systemName.includes('hourglass')) return materialIcons.hourglass;
	if (systemName.includes('location')) return materialIcons.location;
	if (systemName.includes('link')) return materialIcons.link;
	if (systemName.includes('pause')) return materialIcons.pause;
	if (systemName.includes('play')) return materialIcons.play;
	if (
		systemName.includes('clockwise') ||
		systemName.includes('counterclockwise') ||
		systemName.includes('circlepath')
	)
		return materialIcons.refresh;
	if (systemName.includes('exclamationmark')) return materialIcons.warning;
	if (systemName.includes('info')) return materialIcons.info;
	if (systemName.includes('pin')) return materialIcons.pin;
	if (
		systemName.includes('arrow.up') ||
		systemName.includes('square.and.arrow.up')
	)
		return materialIcons.open;
	if (systemName.includes('window')) return materialIcons.window;
	if (systemName.includes('ellipsis')) return materialIcons.more;
	if (systemName.includes('icloud') || systemName.includes('cloud'))
		return materialIcons.cloud;
	return materialIcons.build;
}

export function SystemIcon({
	systemName,
	size = 20,
	color = Platform.OS === 'ios' ? PlatformColor('systemBlueColor') : '#6750A4',
}: SystemIconProps) {
	if (Platform.OS !== 'ios') {
		return (
			<View pointerEvents="none" style={{ height: size, width: size }}>
				<UniversalHost matchContents style={styles.host}>
					<UniversalIcon
						color={color}
						name={universalIconForSystemImage(systemName)}
						size={size}
						testID={`system-icon-${systemName}`}
					/>
				</UniversalHost>
			</View>
		);
	}
	return (
		<View pointerEvents="none" style={{ height: size, width: size }}>
			<Host style={styles.host}>
				<Image
					color={color}
					modifiers={[frame({ width: size, height: size })]}
					size={size}
					systemName={systemName}
				/>
			</Host>
		</View>
	);
}

const styles = StyleSheet.create({
	host: {
		flex: 1,
	},
});
