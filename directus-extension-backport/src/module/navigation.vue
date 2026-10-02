<template>
	<v-list nav>
		<v-list-item to="/backport" exact>
			<v-list-item-icon><v-icon name="swords" /></v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow text="Catalog" />
			</v-list-item-content>
		</v-list-item>
		<v-list-item to="/backport/settings">
			<v-list-item-icon><v-icon name="settings" /></v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow text="Settings" />
			</v-list-item-content>
		</v-list-item>
	</v-list>
</template>

<script setup lang="ts"></script>
