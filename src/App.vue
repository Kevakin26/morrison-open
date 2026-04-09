<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'
import { useChatStore } from './stores/chat'
import { supabase } from './lib/supabase'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const chatStore = useChatStore()

let chatChannel: RealtimeChannel | null = null

onMounted(() => {
  chatChannel = supabase
    .channel('global-chat-notifications')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      if (payload.new && (payload.new as any).user_id !== auth.user?.id && route.name !== 'Chat') {
        chatStore.increment()
      }
    })
    .subscribe()
})

onUnmounted(() => {
  if (chatChannel) {
    supabase.removeChannel(chatChannel)
    chatChannel = null
  }
})

const showNav = computed(() => {
  return auth.isAuthenticated && !['Login', 'Register'].includes(route.name as string)
})

const showHeader = computed(() => {
  return auth.isAuthenticated && !['Login', 'Register', 'Chat', 'Draft'].includes(route.name as string)
})

const tabs = [
  { name: 'Draft', path: '/draft', icon: '\u{1F3E0}', label: 'Home' },
  { name: 'Leaderboard', path: '/leaderboard', icon: '\u{1F3C6}', label: 'Board' },
  { name: 'MyTeam', path: '/my-team', icon: '\u{1F3CC}\uFE0F', label: 'My Team' },
  { name: 'Golfers', path: '/golfers', icon: '\u26F3', label: 'Field' },
  { name: 'Chat', path: '/chat', icon: '\u{1F4AC}', label: 'Chat' },
]

function navigate(path: string) {
  router.push(path)
}
</script>

<template>
  <div class="min-h-screen bg-cream flex flex-col">
    <!-- Header -->
    <header v-if="showHeader" class="bg-augusta-gradient text-white px-4 py-3 flex items-center justify-between safe-top">
      <div class="w-full max-w-4xl mx-auto flex items-center justify-between">
        <div class="flex items-center gap-2">
          <img src="/masters-logo.png" alt="Masters" class="h-6" />
          <h1 class="text-lg md:text-xl font-bold tracking-wide text-gold-glow">THE MORRISON OPEN</h1>
        </div>
        <button
          @click="auth.logout().catch(console.error).then(() => router.push('/login'))"
          class="text-sm text-cream/80 hover:text-white transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
        >
          Sign Out
        </button>
      </div>
    </header>

    <!-- Main Content -->
    <main class="flex-1 overflow-y-auto" :class="showNav ? 'pb-20' : ''">
      <router-view />
    </main>

    <!-- Bottom Tab Bar -->
    <nav v-if="showNav" class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 safe-bottom z-50">
      <div class="flex justify-around items-center h-16 max-w-2xl mx-auto">
        <button
          v-for="tab in tabs"
          :key="tab.name"
          @click="navigate(tab.path)"
          class="flex flex-col items-center justify-center w-full h-full min-h-[44px] min-w-[44px] transition-colors"
          :class="route.name === tab.name ? 'text-augusta' : 'text-gray-400'"
        >
          <span class="relative">
            <span class="text-2xl md:text-xl">{{ tab.icon }}</span>
            <span
              v-if="tab.name === 'Chat' && chatStore.unreadCount > 0"
              class="absolute -top-1 -right-2 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1"
            >
              {{ chatStore.unreadCount > 99 ? '99+' : chatStore.unreadCount }}
            </span>
          </span>
          <span class="text-[10px] sm:text-xs mt-0.5 font-medium">{{ tab.label }}</span>
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
