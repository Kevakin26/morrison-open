<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const showNav = computed(() => {
  return auth.isAuthenticated && !['Login', 'Register'].includes(route.name as string)
})

const tabs = [
  { name: 'Dashboard', path: '/dashboard', icon: '\u{1F3E0}', label: 'Home' },
  { name: 'Draft', path: '/draft', icon: '\u{1F4CB}', label: 'Draft' },
  { name: 'Leaderboard', path: '/leaderboard', icon: '\u{1F3C6}', label: 'Board' },
  { name: 'MyTeam', path: '/my-team', icon: '\u26F3', label: 'My Team' },
  { name: 'Chat', path: '/chat', icon: '\u{1F4AC}', label: 'Chat' },
]

function navigate(path: string) {
  router.push(path)
}
</script>

<template>
  <div class="min-h-screen bg-cream flex flex-col">
    <!-- Header -->
    <header v-if="showNav" class="bg-augusta-gradient text-white px-4 py-3 flex items-center justify-between safe-top">
      <h1 class="text-lg font-bold tracking-wide text-gold-glow">THE MORRISON OPEN</h1>
      <button
        @click="auth.logout().then(() => router.push('/login'))"
        class="text-sm text-cream/80 hover:text-white transition-colors"
      >
        Sign Out
      </button>
    </header>

    <!-- Main Content -->
    <main class="flex-1 overflow-y-auto" :class="showNav ? 'pb-20' : ''">
      <router-view />
    </main>

    <!-- Bottom Tab Bar -->
    <nav v-if="showNav" class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 safe-bottom z-50">
      <div class="flex justify-around items-center h-16 max-w-lg mx-auto">
        <button
          v-for="tab in tabs"
          :key="tab.name"
          @click="navigate(tab.path)"
          class="flex flex-col items-center justify-center w-full h-full transition-colors"
          :class="route.name === tab.name ? 'text-augusta' : 'text-gray-400'"
        >
          <span class="text-xl">{{ tab.icon }}</span>
          <span class="text-xs mt-0.5 font-medium">{{ tab.label }}</span>
        </button>
      </div>
    </nav>
  </div>
</template>

<style scoped>
.safe-top {
  padding-top: max(0.75rem, env(safe-area-inset-top));
}
.safe-bottom {
  padding-bottom: env(safe-area-inset-bottom);
}
</style>
