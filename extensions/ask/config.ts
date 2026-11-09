export interface AskConfig {
	enableSingleSelect: boolean;
	enableRecommended: boolean;
	enableDescriptions: boolean;
	showCustomOption: boolean;
	enableFreeForm: boolean;
	enableNotes: boolean;
	enableNotifications: boolean;
}

export const defaultConfig: AskConfig = {
	enableSingleSelect: true,
	enableRecommended: true,
	enableDescriptions: true,
	showCustomOption: true,
	enableFreeForm: true,
	enableNotes: true,
	enableNotifications: true,
};
