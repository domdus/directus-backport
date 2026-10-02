import { defineModule } from "@directus/extensions-sdk";
import { userHasAdminAccess } from "../shared/admin";
import ModuleView from "./module.vue";
import SettingsView from "./settings-view.vue";

export default defineModule({
	id: "backport",
	name: "Security Backports",
	icon: "swords",
	routes: [
		{
			path: "",
			component: ModuleView,
		},
		{
			path: "settings",
			component: SettingsView,
		},
	],
	preRegisterCheck(user) {
		return userHasAdminAccess(user);
	},
});
