<template>
	<private-view title="Settings" icon="settings">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Security Backports', to: '/backport' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #sidebar>
			<sidebar-detail id="info" icon="info" title="Info">
				<p class="sidebar-text">
					Studio already includes the patch engine. If Directus will not start, run
					<code>dist/cli.mjs</code> from this extension folder. There is nothing else to install.
				</p>
			</sidebar-detail>
		</template>

		<div class="page-container">
			<v-notice v-if="error" type="danger" class="notice">{{ error }}</v-notice>
			<v-notice v-if="notice" :type="notice.type" class="notice">{{ notice.text }}</v-notice>

			<div v-if="loading" class="loading">
				<v-progress-circular indeterminate />
			</div>

			<template v-else-if="cli">
				<v-divider
					class="section-divider"
					large
					:inline-title="false"
					:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
				>
					<template #icon><v-icon name="system_update" /></template>
					Extension Updates
				</v-divider>
				<p class="explain">
					Check npm for the latest published version and compare it with the installed extension version.
					Patch catalog updates live on the Catalog page.
				</p>
				<div class="actions">
					<v-button secondary :loading="checkingUpdates" @click="checkUpdates(true)">Check Now</v-button>
				</div>
				<div v-if="updateInfo" class="result">
					<v-notice :type="updateNoticeType">
						Current: <strong>{{ updateInfo.current_version }}</strong>
						<template v-if="updateInfo.latest_version">
							· Latest: <strong>{{ updateInfo.latest_version }}</strong>
						</template>
						<template v-if="updateInfo.error"> · {{ updateInfo.error }}</template>
						<template v-else-if="updateInfo.has_update"> · Update available</template>
						<template v-else> · Up to date</template>
					</v-notice>
				</div>

				<v-divider
					class="section-divider add-margin-top"
					large
					:inline-title="false"
					:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
				>
					<template #icon><v-icon name="restart_alt" /></template>
					If Directus does not start
				</v-divider>
				<p class="explain">
					Studio cannot help then. Run the CLI that already ships with this extension
					(<code>dist/cli.mjs</code>). Directus does not need to be up.
				</p>
				<v-notice v-if="!cli.bundled" type="danger" class="notice">
					CLI missing at <code>{{ cli.bundledPath }}</code>. Rebuild so <code>dist/cli.mjs</code> is included.
				</v-notice>
				<p class="sidebar-text mono">{{ cli.rollbackCli }}</p>
				<p class="sidebar-text mono">{{ cli.rollbackDocker }}</p>

				<v-divider
					class="section-divider add-margin-top"
					large
					:inline-title="false"
					:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
				>
					<template #icon><v-icon name="folder_delete" /></template>
					Working Files
				</v-divider>
				<p class="explain">
					This removes <code>desired.json</code> (persist list) and <code>.directus-backport</code> (snapshots
					and state). It does not un-patch <code>node_modules</code>. Rollback applied patches from the catalog
					first if you want the original files back.
				</p>
				<p class="sidebar-text mono">{{ cli.desiredFile }}</p>
				<p class="sidebar-text mono">{{ cli.dataDir }}</p>
				<div class="actions">
					<v-button kind="danger" secondary :disabled="busy || !cli.workingFilesPresent" :loading="busy" @click="confirmPurge = true">
						Remove Working Files
					</v-button>
				</div>
			</template>
		</div>

		<v-dialog v-model="confirmPurge">
			<v-card class="confirm-card">
				<v-card-title>Remove working files?</v-card-title>
				<v-card-text>
					Snapshots and the persist list will be deleted. Applied patches in <code>node_modules</code> stay
					until you roll them back.
				</v-card-text>
				<v-card-actions class="dialog-actions">
					<v-button kind="danger" :loading="busy" @click="purgeFiles">Remove</v-button>
					<v-button secondary @click="confirmPurge = false">Cancel</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import ModuleNavigation from './navigation.vue';
import {
	EXTENSION_GITHUB_URL,
	EXTENSION_NPM_URL,
} from '../shared/extension-meta';

type CliStatus = {
	bundled: boolean;
	bundledPath: string;
	rollbackCli: string;
	rollbackDocker: string;
	desiredFile: string;
	dataDir: string;
	workingFilesPresent: boolean;
};

type UpdateInfo = {
	current_version: string;
	latest_version: string | null;
	has_update: boolean;
	checked_at: string;
	error?: string;
	links: { npm: string; github: string; marketplace: string | null };
};

const api = useApi();
const loading = ref(true);
const busy = ref(false);
const checkingUpdates = ref(false);
const error = ref('');
const notice = ref<{ type: string; text: string } | null>(null);
const cli = ref<CliStatus | null>(null);
const confirmPurge = ref(false);
const updateInfo = ref<UpdateInfo | null>(null);

const updateNoticeType = computed(() => {
	if (!updateInfo.value) return 'info';
	if (updateInfo.value.error) return 'warning';
	return updateInfo.value.has_update ? 'warning' : 'success';
});

async function load() {
	loading.value = true;
	error.value = '';
	try {
		const { data } = await api.get('/backport/tools');
		cli.value = data.data;
	} catch (err: any) {
		error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Failed to load settings';
	} finally {
		loading.value = false;
	}
}

async function checkUpdates(force: boolean) {
	checkingUpdates.value = true;
	try {
		const res = await api.get('/backport/update-check', {
			params: { force: force ? '1' : undefined },
		});
		updateInfo.value = res.data?.data || null;
	} catch (err: any) {
		updateInfo.value = {
			current_version: 'unknown',
			latest_version: null,
			has_update: false,
			checked_at: new Date().toISOString(),
			error: err?.response?.data?.errors?.[0]?.message || err?.message || 'Update check failed',
			links: {
				npm: EXTENSION_NPM_URL,
				github: EXTENSION_GITHUB_URL,
				marketplace: null,
			},
		};
	} finally {
		checkingUpdates.value = false;
	}
}

async function purgeFiles() {
	confirmPurge.value = false;
	busy.value = true;
	error.value = '';
	notice.value = null;
	try {
		const { data } = await api.post('/backport/tools/purge-files');
		const n = data.data?.removed?.length ?? 0;
		notice.value = { type: 'success', text: n ? `Removed ${n} path${n === 1 ? '' : 's'}` : 'Nothing to remove' };
		await load();
	} catch (err: any) {
		error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Remove failed';
	} finally {
		busy.value = false;
	}
}

onMounted(load);
</script>

<style scoped>
.page-container {
	padding: var(--content-padding);
	padding-block-end: var(--content-padding-bottom);
	max-inline-size: 67.5rem;
}

.notice {
	margin-bottom: 16px;
}

.loading {
	display: flex;
	justify-content: center;
	padding: 48px 0;
}

.section-divider {
	margin-bottom: 12px;
}

.section-divider.add-margin-top {
	margin-top: 40px;
}

.explain,
.sidebar-text {
	margin: 0 0 16px;
	line-height: 1.55;
	color: var(--theme--foreground-subdued);
}

.sidebar-text.mono,
.mono {
	font-family: var(--theme--fonts--monospace--font-family), ui-monospace, monospace;
	font-size: 12px;
	word-break: break-all;
	color: var(--theme--foreground);
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-bottom: 16px;
}

.result {
	margin-bottom: 16px;
}

.confirm-card {
	max-inline-size: 32rem;
}

.dialog-actions {
	justify-content: flex-end;
}
</style>
