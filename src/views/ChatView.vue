<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'

import type { Database } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Message = Database['public']['Tables']['messages']['Row']
type MessageReaction = Database['public']['Tables']['message_reactions']['Row']
interface ReactionGroup {
  emoji: string
  count: number
  userIds: string[]
}

interface MessageWithMeta extends Message {
  reactions: ReactionGroup[]
  senderName: string
}

const auth = useAuthStore()
const chatStore = useChatStore()

const messages = ref<MessageWithMeta[]>([])
const profiles = ref<Map<string, string>>(new Map())
const newMessage = ref('')
const feedRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const loading = ref(false)
const hasMore = ref(true)
const userScrolledUp = ref(false)
const showMentionDropdown = ref(false)
const mentionSearch = ref('')
const mentionCursorPos = ref(0)
const activeReactionMessageId = ref<string | null>(null)
const hoverMessageId = ref<string | null>(null)
let longPressTimer: ReturnType<typeof setTimeout> | null = null

let messagesChannel: RealtimeChannel | null = null
let reactionsChannel: RealtimeChannel | null = null

const PAGE_SIZE = 50

const REACTION_EMOJIS = ['👍', '😂', '🔥', '💀', '👏', '❤️', '😭', '⛳']

const messageCount = computed(() => messages.value.length)

const filteredProfiles = computed(() => {
  const search = mentionSearch.value.toLowerCase()
  const entries = Array.from(profiles.value.entries())
  if (!search) return entries
  return entries.filter(([, name]) => name.toLowerCase().includes(search))
})

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay === 1) return 'yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderContent(content: string): string {
  const escaped = escapeHtml(content)
  return escaped.replace(
    /@(\w[\w\s]*?\w|\w)/g,
    '<span class="bg-gold/20 text-augusta font-semibold px-0.5 rounded">@$1</span>'
  )
}

function groupReactions(reactions: MessageReaction[]): ReactionGroup[] {
  const map = new Map<string, { count: number; userIds: string[] }>()
  for (const r of reactions) {
    const existing = map.get(r.emoji)
    if (existing) {
      existing.count++
      existing.userIds.push(r.user_id)
    } else {
      map.set(r.emoji, { count: 1, userIds: [r.user_id] })
    }
  }
  return Array.from(map.entries()).map(([emoji, data]) => ({
    emoji,
    count: data.count,
    userIds: data.userIds,
  }))
}

async function fetchProfiles() {
  const { data } = await supabase.from('profiles').select('*')
  if (data) {
    for (const p of data) {
      profiles.value.set(p.id, p.display_name)
    }
  }
}

async function fetchMessages(before?: string) {
  loading.value = true
  let query = supabase
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE)

  if (before) {
    query = query.lt('created_at', before)
  }

  const { data: msgs } = await query
  if (!msgs) {
    loading.value = false
    return
  }

  if (msgs.length < PAGE_SIZE) {
    hasMore.value = false
  }

  const messageIds = msgs.map((m) => m.id)
  let reactions: MessageReaction[] = []
  if (messageIds.length > 0) {
    const { data: reactionsData } = await supabase
      .from('message_reactions')
      .select('*')
      .in('message_id', messageIds)
    reactions = reactionsData || []
  }

  const reactionsByMessage = new Map<string, MessageReaction[]>()
  for (const r of reactions) {
    const existing = reactionsByMessage.get(r.message_id) || []
    existing.push(r)
    reactionsByMessage.set(r.message_id, existing)
  }

  const enriched: MessageWithMeta[] = msgs.map((m) => ({
    ...m,
    reactions: groupReactions(reactionsByMessage.get(m.id) || []),
    senderName: profiles.value.get(m.user_id) || 'Unknown',
  }))

  // Reverse to ascending order
  enriched.reverse()

  if (before) {
    messages.value = [...enriched, ...messages.value]
  } else {
    messages.value = enriched
  }

  loading.value = false
}

async function loadMore() {
  if (!messages.value.length || !hasMore.value) return
  const oldest = messages.value[0]
  await fetchMessages(oldest.created_at)
}

async function sendMessage() {
  if (!newMessage.value.trim() || !auth.user) return
  const content = newMessage.value.trim()
  newMessage.value = ''  // Optimistic clear for good UX
  if (inputRef.value) {
    inputRef.value.style.height = 'auto'
  }

  const { error } = await supabase.from('messages').insert({
    user_id: auth.user.id,
    content,
  })

  if (error) {
    newMessage.value = content  // Restore on failure
    console.error('Failed to send message:', error)
    return
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (showMentionDropdown.value) {
    if (e.key === 'Escape') {
      showMentionDropdown.value = false
      e.preventDefault()
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
    return
  }
}

function handleInput(e: Event) {
  const target = e.target as HTMLTextAreaElement
  // Auto-grow
  target.style.height = 'auto'
  target.style.height = Math.min(target.scrollHeight, 80) + 'px'

  // Check for @ trigger
  const val = target.value
  const cursorPos = target.selectionStart || 0
  const textBefore = val.substring(0, cursorPos)
  const atMatch = textBefore.match(/@(\w*)$/)

  if (atMatch) {
    showMentionDropdown.value = true
    mentionSearch.value = atMatch[1]
    mentionCursorPos.value = cursorPos
  } else {
    showMentionDropdown.value = false
    mentionSearch.value = ''
  }
}

function insertMention(_userId: string, name: string) {
  const val = newMessage.value
  const cursorPos = mentionCursorPos.value
  const textBefore = val.substring(0, cursorPos)
  const textAfter = val.substring(cursorPos)
  const atIndex = textBefore.lastIndexOf('@')
  const before = val.substring(0, atIndex)
  newMessage.value = `${before}@${name} ${textAfter}`
  showMentionDropdown.value = false
  nextTick(() => {
    inputRef.value?.focus()
  })
}

function handleScroll() {
  if (!feedRef.value) return
  const el = feedRef.value
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  userScrolledUp.value = distFromBottom > 100
}

function scrollToBottom() {
  nextTick(() => {
    if (feedRef.value) {
      feedRef.value.scrollTop = feedRef.value.scrollHeight
    }
  })
}

function toggleReactionPicker(messageId: string) {
  activeReactionMessageId.value =
    activeReactionMessageId.value === messageId ? null : messageId
}

async function toggleReaction(messageId: string, emoji: string) {
  if (!auth.user) return

  const msg = messages.value.find((m) => m.id === messageId)
  if (!msg) return

  const group = msg.reactions.find((r) => r.emoji === emoji)
  const alreadyReacted = group?.userIds.includes(auth.user.id)

  if (alreadyReacted) {
    const { error } = await supabase
      .from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', auth.user.id)
      .eq('emoji', emoji)

    if (error) return
    if (group) {
      group.userIds = group.userIds.filter((id) => id !== auth.user!.id)
      group.count--
      if (group.count === 0) {
        msg.reactions = msg.reactions.filter((r) => r.emoji !== emoji)
      }
    }
  } else {
    const { error } = await supabase.from('message_reactions').insert({
      message_id: messageId,
      user_id: auth.user.id,
      emoji,
    })

    if (error) return
    if (group) {
      group.userIds.push(auth.user.id)
      group.count++
    } else {
      msg.reactions.push({ emoji, count: 1, userIds: [auth.user.id] })
    }
  }

  activeReactionMessageId.value = null
}

function handleLongPressStart(messageId: string) {
  longPressTimer = setTimeout(() => {
    toggleReactionPicker(messageId)
  }, 500)
}

function handleLongPressEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function setupRealtimeSubscriptions() {
  messagesChannel = supabase
    .channel('messages-realtime')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => {
        const newMsg = payload.new as Message
        // Avoid duplicates
        if (messages.value.some((m) => m.id === newMsg.id)) return

        const enriched: MessageWithMeta = {
          ...newMsg,
          reactions: [],
          senderName: profiles.value.get(newMsg.user_id) || 'Unknown',
        }
        messages.value.push(enriched)

        if (!userScrolledUp.value) {
          scrollToBottom()
        }
      }
    )
    .subscribe()

  reactionsChannel = supabase
    .channel('reactions-realtime')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'message_reactions' },
      (payload) => {
        const reaction = payload.new as MessageReaction
        // Skip if it's our own optimistic update
        if (reaction.user_id === auth.user?.id) return

        const msg = messages.value.find((m) => m.id === reaction.message_id)
        if (!msg) return

        const group = msg.reactions.find((r) => r.emoji === reaction.emoji)
        if (group) {
          if (!group.userIds.includes(reaction.user_id)) {
            group.userIds.push(reaction.user_id)
            group.count++
          }
        } else {
          msg.reactions.push({
            emoji: reaction.emoji,
            count: 1,
            userIds: [reaction.user_id],
          })
        }
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'message_reactions' },
      (payload) => {
        const reaction = payload.old as MessageReaction
        if (reaction.user_id === auth.user?.id) return

        const msg = messages.value.find((m) => m.id === reaction.message_id)
        if (!msg) return

        const group = msg.reactions.find((r) => r.emoji === reaction.emoji)
        if (group) {
          group.userIds = group.userIds.filter((id) => id !== reaction.user_id)
          group.count--
          if (group.count === 0) {
            msg.reactions = msg.reactions.filter((r) => r.emoji !== reaction.emoji)
          }
        }
      }
    )
    .subscribe()
}

onMounted(async () => {
  chatStore.reset()
  await fetchProfiles()
  await fetchMessages()
  scrollToBottom()
  setupRealtimeSubscriptions()
})

onUnmounted(() => {
  if (messagesChannel) supabase.removeChannel(messagesChannel)
  if (reactionsChannel) supabase.removeChannel(reactionsChannel)
})
</script>

<template>
  <div class="flex flex-col h-full bg-cream overflow-hidden">
    <!-- Header -->
    <div class="bg-augusta text-white px-4 py-3 shadow-md flex-shrink-0">
      <div class="flex items-center justify-between max-w-2xl mx-auto">
        <h1 class="text-lg font-bold tracking-tight">Morrison Open Chat</h1>
        <span class="text-sm text-white/70">{{ messageCount }} messages</span>
      </div>
    </div>

    <!-- Message Feed -->
    <div
      ref="feedRef"
      class="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 py-3 pb-32 space-y-3"
      @scroll="handleScroll"
    >
      <div class="max-w-2xl mx-auto">
        <!-- Load More -->
        <div v-if="hasMore" class="text-center mb-4">
          <button
            class="text-sm text-augusta hover:text-augusta-dark font-medium px-4 py-1.5 bg-white rounded-full shadow-sm hover:shadow transition-all"
            :disabled="loading"
            @click="loadMore"
          >
            {{ loading ? 'Loading...' : 'Load more' }}
          </button>
        </div>

        <!-- Messages -->
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="flex flex-col"
          :class="msg.user_id === auth.user?.id ? 'items-end' : 'items-start'"
        >
          <!-- Sender name -->
          <span
            class="text-xs font-bold mb-0.5 px-2"
            :class="msg.user_id === auth.user?.id ? 'text-augusta-dark' : 'text-dark/60'"
          >
            {{ msg.senderName }}
          </span>

          <!-- Message bubble wrapper (for reactions picker positioning) -->
          <div
            class="relative max-w-[85%] sm:max-w-[75%] md:max-w-md group"
            @mouseenter="hoverMessageId = msg.id"
            @mouseleave="hoverMessageId = null; activeReactionMessageId === msg.id ? null : null"
            @touchstart="handleLongPressStart(msg.id)"
            @touchend="handleLongPressEnd()"
            @touchcancel="handleLongPressEnd()"
          >
            <!-- Bubble -->
            <div
              class="px-3 py-2 rounded-2xl shadow-sm text-sm leading-relaxed break-words"
              :class="
                msg.user_id === auth.user?.id
                  ? 'bg-augusta text-white rounded-br-md'
                  : 'bg-white text-dark rounded-bl-md'
              "
              v-html="renderContent(msg.content)"
            />

            <!-- Hover reaction button (desktop) -->
            <button
              v-if="hoverMessageId === msg.id"
              class="hidden md:flex absolute -top-3 bg-white shadow-md rounded-full w-7 h-7 items-center justify-center text-sm hover:bg-gray-50 transition-colors border border-gray-100"
              :class="msg.user_id === auth.user?.id ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'"
              @click.stop="toggleReactionPicker(msg.id)"
            >
              😊
            </button>

            <!-- Reaction Picker -->
            <div
              v-if="activeReactionMessageId === msg.id"
              class="absolute z-20 bottom-full mb-1 bg-white rounded-full shadow-lg px-2 py-1.5 flex gap-1"
              :class="msg.user_id === auth.user?.id ? 'right-0' : 'left-0'"
            >
              <button
                v-for="emoji in REACTION_EMOJIS"
                :key="emoji"
                class="w-8 h-8 flex items-center justify-center text-lg hover:bg-gray-100 rounded-full transition-colors hover:scale-110"
                @click.stop="toggleReaction(msg.id, emoji)"
              >
                {{ emoji }}
              </button>
            </div>

            <!-- Reactions display -->
            <div
              v-if="msg.reactions.length > 0"
              class="flex flex-wrap gap-1 mt-1"
              :class="msg.user_id === auth.user?.id ? 'justify-end' : 'justify-start'"
            >
              <button
                v-for="reaction in msg.reactions"
                :key="reaction.emoji"
                class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs border transition-colors"
                :class="
                  reaction.userIds.includes(auth.user?.id || '')
                    ? 'bg-augusta/10 border-augusta/30 text-augusta'
                    : 'bg-white border-gray-200 text-dark/70 hover:border-gray-300'
                "
                @click="toggleReaction(msg.id, reaction.emoji)"
              >
                <span>{{ reaction.emoji }}</span>
                <span class="font-medium">{{ reaction.count }}</span>
              </button>
            </div>
          </div>

          <!-- Timestamp -->
          <span class="text-[10px] text-dark/40 mt-0.5 px-2">
            {{ formatTimestamp(msg.created_at) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Mention Dropdown -->
    <div
      v-if="showMentionDropdown && filteredProfiles.length > 0"
      class="mx-4 mb-1 max-w-2xl lg:mx-auto bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden"
    >
      <button
        v-for="[id, name] in filteredProfiles"
        :key="id"
        class="w-full text-left px-4 py-2.5 text-sm hover:bg-augusta/5 text-dark transition-colors flex items-center gap-2 border-b border-gray-50 last:border-0"
        @click="insertMention(id, name)"
      >
        <span class="w-6 h-6 rounded-full bg-augusta text-white flex items-center justify-center text-xs font-bold flex-shrink-0">
          {{ name.charAt(0).toUpperCase() }}
        </span>
        <span class="font-medium">{{ name }}</span>
      </button>
    </div>

    <!-- Input Bar -->
    <div class="fixed bottom-16 left-0 right-0 bg-white border-t border-dark/10 px-3 py-2 safe-bottom-chat z-40">
      <div class="max-w-2xl mx-auto flex items-end gap-2">
        <textarea
          ref="inputRef"
          v-model="newMessage"
          placeholder="Send a message..."
          rows="1"
          class="flex-1 resize-none rounded-2xl border border-gray-300 px-4 py-2.5 text-sm sm:text-base min-h-[44px] focus:outline-none focus:border-augusta focus:ring-1 focus:ring-augusta/30 bg-cream/50 placeholder-dark/30"
          style="max-height: 80px"
          @keydown="handleKeydown"
          @input="handleInput"
        />
        <button
          class="flex-shrink-0 w-11 h-11 min-w-[44px] min-h-[44px] rounded-full flex items-center justify-center transition-all"
          :class="
            newMessage.trim()
              ? 'bg-gold text-white shadow-sm hover:shadow-md hover:bg-gold/90'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          "
          :disabled="!newMessage.trim()"
          @click="sendMessage"
        >
          <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
