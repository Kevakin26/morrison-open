<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const showNav = computed(() => auth.isAuthenticated && !['Login', 'Register'].includes(route.name as string))
const showHeader = computed(() => auth.isAuthenticated && !['Login', 'Register'].includes(route.name as string))

const tabs = [
  { name: 'Home', path: '/home', icon: '🏠', label: 'Home' },
  { name: 'Draft', path: '/draft', icon: '🎯', label: 'Draft' },
  { name: 'Live', path: '/live', icon: '⛳', label: 'Live' },
  { name: 'Standings', path: '/standings', icon: '🏆', label: 'Standings' },
  { name: 'History', path: '/history', icon: '📅', label: 'History' },
]

function navigate(path: string) { router.push(path) }
</script>

<template>
  <div class="min-h-screen bg-cream flex flex-col">
    <header v-if="showHeader" class="bg-augusta-gradient text-white px-4 py-3 flex items-center justify-between safe-top">
      <div class="w-full max-w-4xl mx-auto flex items-center justify-between">
        <router-link to="/home" class="flex items-center gap-2">
          <span class="text-2xl">⛳</span>
          <h1 class="text-lg md:text-xl font-bold tracking-wide text-gold-glow">MORRISON OPEN</h1>
        </router-link>
        <button
          @click="auth.logout().catch(console.error).then(() => router.push('/login'))"
          class="text-sm text-cream/80 hover:text-white transition-colors min-h-[44px] flex items-center"
        >
          Sign Out
        </button>
      </div>
    </header>

    <main class="flex-1 overflow-y-auto" :class="showNav ? 'pb-20' : ''">
      <router-view />
    </main>

    <nav v-if="showNav" class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 safe-bottom z-50">
      <div class="flex justify-around items-center h-16 max-w-2xl mx-auto">
        <button
          v-for="tab in tabs"
          :key="tab.name"
          @click="navigate(tab.path)"
          class="flex flex-col items-center justify-center w-full h-full min-h-[44px] transition-colors"
          :class="route.name === tab.name ? 'text-augusta' : 'text-gray-400'"
        >
          <span class="text-2xl md:text-xl">{{ tab.icon }}</span>
          <span class="text-[10px] sm:text-xs mt-0.5 font-medium">{{ tab.label }}</span>
        </button>
      </div>
    </nav>
  </div>
</template>

<style scoped>
.safe-top { padding-top: max(0.75rem, env(safe-area-inset-top)); }
.safe-bottom { padding-bottom: env(safe-area-inset-bottom); }
</style>
