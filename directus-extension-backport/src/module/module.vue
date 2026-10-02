<template>
	<private-view title="Security Backports" icon="swords">
		<template #headline>
			<v-breadcrumb :items="[{ name: 'Security Backports', to: '/backport' }]" />
		</template>

		<template #navigation>
			<module-navigation />
		</template>

		<template #actions>
			<v-button
				v-tooltip.bottom="'Check for Updates — fetch catalog from GitHub (does not apply patches)'"
				icon
				rounded
				secondary
				:disabled="busy || restartPhase !== 'idle' || !report?.catalogRemote?.configured"
				:loading="catalogBusy"
				@click="refreshCatalog"
			>
				<v-icon name="cloud_download" />
			</v-button>
		</template>

		<template #sidebar>
			<sidebar-detail id="info" icon="info" title="Info">
				<p class="sidebar-text">
					Directus 12.x is where upstream security fixes ship. This module is checksum-pinned to this exact
					Directus version (not every 10.x or 11.x). Each backport here is one of those 12.x fixes, applied
					to this install’s <code>node_modules</code>. You can roll it back.
				</p>
				<p class="sidebar-text">Directus {{ report?.install.version || '…' }}</p>
				<p class="sidebar-text mono">{{ report?.install.nodeModules || rollbackHint }}</p>
			</sidebar-detail>
			<sidebar-detail id="catalog" icon="inventory_2" title="Patch catalog">
				<p class="sidebar-text">
					This extension does not ship overlays. Use <strong>Check for Updates</strong> (header) to opt in and
					fetch the GitHub catalog into <code>catalog-remote/</code>. That does not apply patches.
				</p>
				<p class="sidebar-text">{{ catalogLine }}</p>
				<p v-if="report?.catalogRemote?.advisories" class="sidebar-text mono">{{ report.catalogRemote.advisories }}</p>
			</sidebar-detail>
			<sidebar-detail id="persist" icon="save" title="Keep after rebuild">
				<p class="sidebar-text">
					A Docker recreate wipes <code>node_modules</code>. Applied fixes are stored in
					<code>desired.json</code> next to this extension and put back on the next boot. Set
					<code>DIRECTUS_BACKPORT_AUTO=0</code> to skip that.
				</p>
				<template v-if="report?.desired?.ids?.length">
					<p class="sidebar-text">{{ report.desired.ids.length }} kept after rebuild</p>
					<ul class="sidebar-list">
						<li v-for="id in report.desired.ids" :key="id">{{ id }}</li>
					</ul>
				</template>
				<p v-else class="sidebar-text">Apply a fix to keep it after a rebuild.</p>
			</sidebar-detail>
			<sidebar-detail id="breakage" icon="restart_alt" title="If Directus does not start">
				<p class="sidebar-text">
					Rollback does not need Studio. CLI first, Docker if that is how you run Directus:
				</p>
				<p class="sidebar-text mono">{{ report?.rollbackCli || rollbackHint }}</p>
				<p class="sidebar-text mono">{{ report?.rollbackDocker }}</p>
			</sidebar-detail>
		</template>

		<div class="page-container">
			<div v-if="restartPhase !== 'idle'" class="restart-panel">
				<v-progress-circular v-if="restartPhase !== 'failed'" indeterminate />
				<h2 class="restart-heading">{{ restartTitle }}</h2>
				<p>{{ restartDetail }}</p>
				<p v-if="restartPhase === 'waiting'" class="restart-elapsed">
					{{ waitSeconds }}s elapsed · polling /server/ping
				</p>
				<p v-if="restartPhase === 'failed'" class="sidebar-text mono">{{ rollbackHint }}</p>
				<v-button v-if="restartPhase === 'failed'" @click="reloadStudio">Reload Studio</v-button>
			</div>

			<template v-else>
			<v-notice v-if="report?.ready.length" type="warning" class="notice">
				Apply writes into <code>node_modules</code>. A bad patch can keep Directus from booting. You do not need
				to make a backup first — Apply copies those files itself so Rollback can restore them. Directus then
				restarts on its own. If this page never comes back, run the rollback command from the host.
			</v-notice>

			<v-notice v-if="report && report.cli && !report.cli.bundled" type="danger" class="notice">
				The bundled CLI is missing. Rebuild this extension so host rollback can run if Directus does not start.
			</v-notice>

			<v-notice v-if="error" type="danger" class="notice">{{ error }}</v-notice>
			<v-notice v-if="notice" :type="notice.type" class="notice">{{ notice.text }}</v-notice>

			<div v-if="loading" class="loading">
				<v-progress-circular indeterminate />
			</div>

			<template v-else-if="report">
				<p class="page-intro">{{ introText }}</p>
				<p class="explain">{{ catalogLine }}</p>

				<v-notice v-if="report.catalogMissing" type="info" class="notice">
					No patch catalog on this host yet. Fetch it from GitHub with Check for Updates (does not apply
					anything). Or run <code>cli.mjs catalog --refresh</code>.
					<div class="actions" style="margin-top: 12px">
						<v-button
							:disabled="busy || !report.catalogRemote?.configured"
							:loading="catalogBusy"
							@click="refreshCatalog"
						>
							Check for Updates
						</v-button>
					</div>
				</v-notice>

				<v-notice v-if="report.last?.health === 'failed'" type="danger" class="notice">
					Last apply failed its health check. Rollback now if Studio is flaky.
				</v-notice>

				<v-notice v-if="!canWrite" type="warning" class="notice">
					This process cannot write <code>node_modules</code>
					<template v-if="report.write?.reason"> — {{ report.write.reason }}</template>.
					Apply and rollback are disabled. Run the CLI as a user that owns the install, or bind-mount a writable
					tree.
				</v-notice>

				<div v-if="report.ready.length || report.applied.length" class="actions">
					<v-button
						v-if="report.ready.length"
						secondary
						:disabled="busy || !canWrite || restartPhase !== 'idle' || selected.length === report.ready.length"
						@click="selectAllReady"
					>
						Select All
					</v-button>
					<v-button
						v-if="lastApplyId"
						secondary
						:disabled="busy || !canWrite || restartPhase !== 'idle'"
						@click="askRollbackLast"
					>
						Rollback Last Apply ({{ lastApplyId }})
					</v-button>
					<v-button
						v-if="appliedList.length > 1"
						secondary
						:disabled="busy || !canWrite || restartPhase !== 'idle'"
						@click="askRollbackAll"
					>
						Rollback All ({{ appliedList.length }})
					</v-button>
					<v-button
						v-if="report.ready.length"
						class="actions-apply"
						:disabled="selected.length === 0 || busy || !canWrite || restartPhase !== 'idle'"
						@click="askApply(selected)"
					>
						Apply Selected ({{ selected.length }})
					</v-button>
				</div>

				<template v-if="report.ready.length">
				<v-divider
					class="section-divider"
					large
					:inline-title="false"
					:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
				>
					<template #icon><v-icon name="verified" /></template>
					Available Security Fixes
				</v-divider>

				<div class="list">
					<div
						v-for="item in report.ready"
						:key="item.id"
						class="item"
						:class="{ 'item--selected': selected.includes(item.id), 'item--static': !canWrite }"
						@click="canWrite && toggle(item.id, !selected.includes(item.id))"
					>
						<v-checkbox
							class="item-check"
							:model-value="selected.includes(item.id)"
							:disabled="!canWrite"
							@click.stop
							@update:model-value="(on: boolean | null) => toggle(item.id, on)"
						/>
						<div class="item-body">
							<div class="item-title">
								<strong>{{ item.title }}</strong>
								<v-chip :class="item.severity" x-small>{{ chipLabel(item.severity) }}</v-chip>
							</div>
							<p class="item-meta">{{ item.id }} · Fixed upstream in {{ item.upstreamPatched }}</p>
							<p v-if="item.port.notes" class="item-note">{{ item.port.notes }}</p>
							<a
								class="advisory-link"
								:href="item.advisory"
								target="_blank"
								rel="noreferrer"
								@click.stop
							>Advisory</a>
						</div>
						<div class="item-actions" @click.stop>
							<v-button
								small
								:disabled="!canWrite || busy || restartPhase !== 'idle'"
								@click="askApply([item.id])"
							>
								Apply
							</v-button>
						</div>
					</div>
				</div>
				</template>

				<v-notice v-else-if="!report.applied.length" type="info" class="notice">
					No backports in the catalog yet. Open advisories below are a registry only — they cannot be applied
					until someone ports the 12.x fix onto this exact Directus build.
				</v-notice>

				<template v-if="appliedList.length">
					<v-divider
						class="section-divider"
						:class="{ 'add-margin-top': report.ready.length > 0 }"
						large
						:inline-title="false"
						:style="{ '--v-divider-color': 'var(--theme--border-color-subdued)' }"
					>
						<template #icon><v-icon name="task_alt" /></template>
						Applied
					</v-divider>
					<div class="list">
						<div v-for="item in appliedList" :key="item.id" class="item item--static">
							<div class="item-body">
								<div class="item-title">
									<strong>{{ item.title }}</strong>
									<v-chip :class="item.severity" x-small>{{ chipLabel(item.severity) }}</v-chip>
								</div>
								<p class="item-meta">{{ item.id }} · Fixed upstream in {{ item.upstreamPatched }}</p>
								<a class="advisory-link" :href="item.advisory" target="_blank" rel="noreferrer">Advisory</a>
							</div>
							<div class="item-actions">
								<v-button
									small
									secondary
									:disabled="!canWrite || busy || restartPhase !== 'idle'"
									@click="askRollback(item)"
								>
									Rollback
								</v-button>
							</div>
						</div>
					</div>
				</template>
			</template>
			</template>
		</div>

		<v-dialog v-model="confirmApply">
			<v-card class="confirm-card">
				<v-card-title>Apply {{ pendingApplyIds.length }} backport{{ pendingApplyIds.length === 1 ? '' : 's' }}?</v-card-title>
				<v-card-text>
					These are 12.x security fixes that this Directus version never received. Apply copies the current
					files first so you can roll one back later without undoing the others. Directus then restarts so
					the patched files load. If this page never comes back, run the rollback command from the host.
				</v-card-text>
				<v-card-actions class="dialog-actions">
					<v-button :loading="busy" :disabled="!canWrite" @click="apply">Apply and Restart</v-button>
					<v-button secondary @click="confirmApply = false">Cancel</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>

		<v-dialog v-model="confirmRollback">
			<v-card class="confirm-card">
				<v-card-title>
					Rollback {{ pendingRollbackIds.length }} backport{{ pendingRollbackIds.length === 1 ? '' : 's' }}?
				</v-card-title>
				<v-card-text>
					<p>
						This restores that backport’s files, then this Node process exits so the restored files can load.
					</p>
					<p v-if="pendingRollbackAll">
						This rolls back every applied backport on this install.
					</p>
					<p v-else-if="!pendingRollbackId && pendingRollbackIds.length > 1">
						These {{ pendingRollbackIds.length }} were applied in one action, so they roll back together.
					</p>
					<p v-if="pendingRollbackIds.length && pendingRollbackIds.length === report?.applied.length">
						Every backport on this install is in this rollback, so none will remain.
					</p>
					<p v-else-if="report && pendingRollbackIds.length">
						{{ report.applied.length - pendingRollbackIds.length }} backport{{
							report.applied.length - pendingRollbackIds.length === 1 ? '' : 's'
						}}
						will stay.
					</p>
				</v-card-text>
				<v-card-actions class="dialog-actions">
					<v-button kind="danger" :loading="busy" :disabled="!canWrite" @click="rollback">Rollback and Restart</v-button>
					<v-button secondary @click="confirmRollback = false">Cancel</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
		<v-dialog :model-value="restartOpen" persistent>
			<v-card class="confirm-card">
				<v-card-title>{{ restartTitle }}</v-card-title>
				<v-card-text>
					<div class="restart-status">
						<v-progress-circular v-if="restartPhase !== 'failed'" indeterminate />
						<p>{{ restartDetail }}</p>
						<p v-if="restartPhase === 'waiting'" class="restart-elapsed">
							{{ waitSeconds }}s elapsed · polling /server/ping
						</p>
						<p v-if="restartPhase === 'failed'" class="sidebar-text mono">{{ rollbackHint }}</p>
					</div>
				</v-card-text>
				<v-card-actions v-if="restartPhase === 'failed'" class="dialog-actions">
					<v-button @click="reloadStudio">Reload Studio</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</private-view>
</template>

<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import ModuleNavigation from './navigation.vue';

type Advisory = {
	id: string;
	title: string;
	severity: string;
	advisory: string;
	affects: string;
	upstreamPatched: string;
	port: { status: string; risk: string; notes?: string };
};

type AppliedAdvisory = Advisory & {
	snapshot?: string;
	snapshotIds?: string[];
};

type Report = {
	install: { version: string; root: string; nodeModules: string };
	catalogMissing?: boolean;
	counts: { open: number; ready: number; waiting: number; alreadyFixed: number; applied: number };
	last?: { action: string; health: string };
	applied: { id: string }[];
	appliedCatalog?: AppliedAdvisory[];
	lastApplyIds?: string[];
	ready: Advisory[];
	waiting: Advisory[];
	rollbackHint: string;
	rollbackCli?: string;
	rollbackDocker?: string;
	cli?: { bundled: boolean; bundledPath: string };
	write?: { writable: boolean; snapshotWritable: boolean; nodeModulesWritable: boolean; reason?: string };
	desired?: { version: string; ids: string[]; updated: string };
	desiredFile?: string;
	catalogRemote?: {
		configured: boolean;
		github: string | null;
		ref: string;
		using: string;
		fetchedAt: string | null;
		advisories: string | null;
	};
};

const api = useApi();
const RESTART_KEY = 'directus-backport-restarting';
let responseInterceptor: number | null = null;
const loading = ref(true);
const busy = ref(false);
const catalogBusy = ref(false);
const error = ref('');
const notice = ref<{ type: string; text: string } | null>(null);
const report = ref<Report | null>(null);
const selected = ref<string[]>([]);
const pendingApplyIds = ref<string[]>([]);
const pendingRollbackId = ref('');
const pendingRollbackIds = ref<string[]>([]);
const confirmApply = ref(false);
const confirmRollback = ref(false);
const pendingRollbackAll = ref(false);
const rollbackHint = ref('directus-backport rollback');
const canWrite = computed(() => report.value?.write?.writable !== false);
const appliedList = computed(() => report.value?.appliedCatalog ?? []);
const lastApplyId = computed(() => report.value?.lastApplyIds?.[0] || '');
const introText = computed(() => {
	const current = report.value;
	if (!current) return '';
	if (current.catalogMissing) {
		return `Directus ${current.install.version} — fetch the patch catalog from GitHub to see ready backports.`;
	}
	if (!current.ready.length && !current.applied.length) {
		return `No 12.x security backports in the catalog for Directus ${current.install.version}`;
	}
	const major = String(current.install.version || '').split('.')[0];
	return `These security fixes shipped in Directus 12.x. Version ${major}.x never received them.`;
});
const catalogLine = computed(() => {
	const remote = report.value?.catalogRemote;
	if (!remote) return '';
	const origin = remote.configured ? `${remote.github}@${remote.ref}` : 'GitHub';
	if (remote.using === 'remote' && remote.fetchedAt) {
		return `Using GitHub ${origin} (fetched ${remote.fetchedAt}). Check for Updates refreshes it.`;
	}
	if (remote.using === 'bundled') {
		return `Using a catalog bundled with this install. Check for Updates prefers GitHub ${origin}.`;
	}
	return `No catalog yet. Check for Updates fetches ${origin} (opt-in; does not apply patches).`;
});
const restartPhase = ref<'idle' | 'applying' | 'waiting' | 'reloading' | 'failed'>('idle');
const restartKind = ref<'apply' | 'rollback'>('apply');
const restartCount = ref(0);
const waitSeconds = ref(0);
const restartOpen = computed(() => restartPhase.value !== 'idle');
let waitTicker: ReturnType<typeof setInterval> | null = null;

const restartTitle = computed(() => {
	switch (restartPhase.value) {
		case 'applying':
			return restartKind.value === 'rollback'
				? 'Rolling Back'
				: `Applying ${restartCount.value} Backport${restartCount.value === 1 ? '' : 's'}`;
		case 'waiting':
			return 'Waiting for Directus';
		case 'reloading':
			return 'Reloading Studio';
		case 'failed':
			return 'Directus Did Not Come Back';
		default:
			return '';
	}
});

const restartDetail = computed(() => {
	switch (restartPhase.value) {
		case 'applying':
			return restartKind.value === 'rollback'
				? 'Copying the pre-patch files back, then exiting the Node process.'
				: 'Writing the snapshot and patched files, then exiting the Node process.';
		case 'waiting':
			return 'This Node process is exiting so the patched files can load. Start Directus again if nothing is supervising it. This page reloads when /server/ping returns pong.';
		case 'reloading':
			return 'Ping succeeded. Reloading this page to pick up the patched files.';
		case 'failed':
			return 'Ping never came back. Run rollback from the host — Directus does not need to be up.';
		default:
			return '';
	}
});

function chipLabel(value: string): string {
	return value.replaceAll(/[-_]/g, ' ').replace(/(^|\s)\S/g, (chunk) => chunk.toUpperCase());
}

function selectAllReady() {
	if (!report.value) return;
	selected.value = report.value.ready.map((item) => item.id);
}

function toggle(id: string, on: boolean | null) {
	if (on) {
		if (!selected.value.includes(id)) selected.value = [...selected.value, id];
	} else {
		selected.value = selected.value.filter((item) => item !== id);
	}
}

function askApply(ids: string[]) {
	if (!ids.length) return;
	pendingApplyIds.value = [...ids];
	confirmApply.value = true;
}

function askRollback(item?: AppliedAdvisory) {
	pendingRollbackAll.value = false;
	if (item) {
		pendingRollbackId.value = item.id;
		pendingRollbackIds.value = [item.id];
	} else {
		pendingRollbackIds.value = [...(report.value?.lastApplyIds ?? [])];
		pendingRollbackId.value = pendingRollbackIds.value[0] || '';
	}
	if (!pendingRollbackIds.value.length) return;
	confirmRollback.value = true;
}

function askRollbackLast() {
	askRollback();
}

function askRollbackAll() {
	pendingRollbackAll.value = true;
	pendingRollbackId.value = '';
	pendingRollbackIds.value = (report.value?.appliedCatalog ?? []).map((item) => item.id);
	if (!pendingRollbackIds.value.length) return;
	confirmRollback.value = true;
}

async function load() {
	loading.value = true;
	error.value = '';
	try {
		const { data } = await api.get('/backport');
		report.value = data.data;
		rollbackHint.value = data.data.rollbackHint;
	} catch (err: any) {
		error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Failed to load catalog';
	} finally {
		loading.value = false;
	}
}

async function refreshCatalog() {
	catalogBusy.value = true;
	error.value = '';
	notice.value = null;
	try {
		const { data } = await api.post('/backport/catalog/refresh');
		notice.value = {
			type: 'success',
			text: `Catalog updated from ${data.data.github}@${data.data.ref} (${data.data.files} files). Nothing was applied.`,
		};
		await load();
	} catch (err: any) {
		error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Catalog update failed';
	} finally {
		catalogBusy.value = false;
	}
}

function isTransportError(err: any): boolean {
	if (err?.code === 'ERR_NETWORK' || err?.message === 'Network Error') return true;
	if (!err?.response) return true;
	const status = err.response.status;
	return status === 502 || status === 503 || status === 504;
}

function isBackportMutation(err: any): boolean {
	return /\/backport\/(apply|rollback)\b/.test(String(err?.config?.url ?? ''));
}

function swallowDuringRestart(err: any) {
	const restarting = restartPhase.value !== 'idle' || sessionStorage.getItem(RESTART_KEY) === '1';
	if (restarting && isTransportError(err) && !isBackportMutation(err)) {
		return new Promise(() => {});
	}
	return Promise.reject(err);
}

function onUnhandledRejection(event: PromiseRejectionEvent) {
	const restarting = restartPhase.value !== 'idle' || sessionStorage.getItem(RESTART_KEY) === '1';
	if (restarting && isTransportError(event.reason)) {
		event.preventDefault();
	}
}

function markRestarting() {
	sessionStorage.setItem(RESTART_KEY, '1');
}

function reloadStudio() {
	sessionStorage.removeItem(RESTART_KEY);
	window.location.reload();
}

async function pingOnce(): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 3000);
		const res = await fetch(`${window.location.origin}/server/ping`, {
			signal: ctrl.signal,
			cache: 'no-store',
		});
		clearTimeout(timer);
		if (!res.ok) return false;
		const body = (await res.text()).trim().toLowerCase();
		return body === 'pong' || body.length > 0;
	} catch {
		return false;
	}
}

async function waitForDirectus(timeoutMs = 120_000) {
	restartPhase.value = 'waiting';
	waitSeconds.value = 0;
	const started = Date.now();
	if (waitTicker) clearInterval(waitTicker);
	waitTicker = setInterval(() => {
		waitSeconds.value = Math.floor((Date.now() - started) / 1000);
	}, 250);
	let hits = 0;
	try {
		while (Date.now() - started < timeoutMs) {
			if (await pingOnce()) {
				hits += 1;
				if (hits >= 2) {
					restartPhase.value = 'reloading';
					await new Promise((resolve) => setTimeout(resolve, 600));
					reloadStudio();
					return;
				}
			} else {
				hits = 0;
			}
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
		restartPhase.value = 'failed';
	} finally {
		if (waitTicker) {
			clearInterval(waitTicker);
			waitTicker = null;
		}
	}
}

async function apply() {
	restartCount.value = pendingApplyIds.value.length;
	restartKind.value = 'apply';
	confirmApply.value = false;
	busy.value = true;
	error.value = '';
	notice.value = null;
	markRestarting();
	restartPhase.value = 'applying';
	try {
		await api.post('/backport/apply', { ids: pendingApplyIds.value, restart: true });
	} catch (err: any) {
		if (!isTransportError(err) && err?.response?.status) {
			restartPhase.value = 'idle';
			error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Apply failed';
			busy.value = false;
			await load();
			return;
		}
	}
	selected.value = [];
	pendingApplyIds.value = [];
	await waitForDirectus();
	busy.value = false;
}

async function rollback() {
	restartCount.value = pendingRollbackIds.value.length;
	restartKind.value = 'rollback';
	confirmRollback.value = false;
	busy.value = true;
	error.value = '';
	notice.value = null;
	markRestarting();
	restartPhase.value = 'applying';
	try {
		await api.post('/backport/rollback', {
			id: pendingRollbackAll.value ? undefined : pendingRollbackId.value || undefined,
			all: pendingRollbackAll.value || undefined,
			restart: true,
		});
	} catch (err: any) {
		if (!isTransportError(err) && err?.response?.status) {
			restartPhase.value = 'idle';
			error.value = err?.response?.data?.errors?.[0]?.message || err?.message || 'Rollback failed';
			busy.value = false;
			return;
		}
	}
	pendingRollbackId.value = '';
	pendingRollbackIds.value = [];
	pendingRollbackAll.value = false;
	await waitForDirectus();
	busy.value = false;
}

onMounted(() => {
	responseInterceptor = api.interceptors.response.use((res) => res, swallowDuringRestart);
	window.addEventListener('unhandledrejection', onUnhandledRejection);
	if (sessionStorage.getItem(RESTART_KEY) === '1') sessionStorage.removeItem(RESTART_KEY);
	load();
});

onUnmounted(() => {
	if (responseInterceptor !== null) api.interceptors.response.eject(responseInterceptor);
	window.removeEventListener('unhandledrejection', onUnhandledRejection);
});
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

.page-intro,
.explain,
.sidebar-text {
	margin: 0 0 24px;
	line-height: 1.55;
	color: var(--theme--foreground);
}

.explain {
	margin-bottom: 16px;
	color: var(--theme--foreground-subdued);
}

.sidebar-text {
	margin: 0 0 8px;
}

.sidebar-text.mono,
.mono {
	font-family: var(--theme--fonts--monospace--font-family), ui-monospace, monospace;
	font-size: 12px;
	word-break: break-all;
}

.sidebar-list {
	margin: 0 0 8px;
	padding-inline-start: 1.1em;
	font-family: var(--theme--fonts--monospace--font-family), ui-monospace, monospace;
	font-size: 12px;
	line-height: 1.55;
	word-break: break-all;
}

.actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	margin-bottom: 16px;
}

.actions-apply {
	margin-inline-start: auto;
}

.list {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.item {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	width: 100%;
	padding: 14px 16px;
	text-align: left;
	cursor: pointer;
	color: inherit;
	font: inherit;
	background: var(--theme--background);
	border: var(--theme--border-width, 1px) solid var(--theme--border-color-subdued);
	border-radius: var(--theme--border-radius, 8px);
}

.item:hover:not(.item--static) {
	border-color: var(--theme--primary);
}

.item--static {
	cursor: default;
}

.item--selected {
	border-color: var(--theme--primary);
	box-shadow: inset 0 0 0 1px var(--theme--primary);
}

.item--selected .item-title strong {
	color: var(--theme--primary);
}

.item-check {
	flex-shrink: 0;
	margin-top: 2px;
}

.item-body {
	min-width: 0;
	flex: 1;
}

.item-actions {
	flex-shrink: 0;
	align-self: center;
}

.item-title {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.item-meta {
	margin: 6px 0 0;
	font-family: var(--theme--fonts--monospace--font-family), ui-monospace, monospace;
	font-size: 13px;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.item-note {
	margin: 6px 0 0;
	font-size: 13px;
	line-height: 1.45;
	color: var(--theme--foreground-subdued);
}

.advisory-link {
	display: inline-block;
	margin-top: 6px;
	font-size: 13px;
}

.critical {
	--v-chip-color: var(--theme--danger);
}

.high {
	--v-chip-color: var(--theme--warning);
}

.confirm-card {
	min-width: min(100%, 420px);
}

.confirm-card p {
	margin: 0 0 12px;
	line-height: 1.55;
}

.confirm-card p:last-child {
	margin-bottom: 0;
}

.restart-panel {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 16px;
	padding: 48px 16px;
	text-align: center;
}

.restart-heading {
	margin: 0;
	font-size: 18px;
	font-weight: 600;
}

.restart-panel p {
	margin: 0;
	max-inline-size: 36rem;
	line-height: 1.55;
}

.restart-status {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 16px;
	padding: 8px 0 16px;
	text-align: center;
}

.restart-status p {
	margin: 0;
	line-height: 1.55;
}

.restart-elapsed {
	color: var(--theme--foreground-subdued);
	font-size: 13px;
}

.dialog-actions {
	display: flex;
	flex-wrap: wrap;
	flex-direction: column;
	align-items: stretch;
	justify-content: flex-start;
	gap: 8px;
	padding-inline: 16px;
	padding-bottom: 16px;
}

.dialog-actions :deep(.v-button),
.dialog-actions :deep(button) {
	width: 100%;
	justify-content: center;
}
</style>
