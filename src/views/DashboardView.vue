<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'

import type { Database } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Tournament = Database['public']['Tables']['tournaments']['Row']
type ReadyCheck = Database['public']['Tables']['ready_checks']['Row']
type Profile = Database['public']['Tables']['profiles']['Row']
type DraftPick = Database['public']['Tables']['draft_picks']['Row']
type GolferScore = Database['public']['Tables']['golfer_scores']['Row']
type Golfer = Database['public']['Tables']['golfers']['Row']
type Message = Database['public']['Tables']['messages']['Row']
type MessageReaction = Database['public']['Tables']['message_reactions']['Row']

interface DraftState {
  id: string
  tournament_id: string
  status: string
  draft_order: string[]
  current_pick_index: number
  pick_deadline: string | null
  created_at: string
}

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

// ─── Tournament State ───
const tournament = ref<Tournament | null>(null)
const draftState = ref<DraftState | null>(null)
const readyChecks = ref<ReadyCheck[]>([])
const profiles = ref<Profile[]>([])
const golferCount = ref(0)
const loading = ref(true)
const togglingReady = ref(false)
const draftPicks = ref<DraftPick[]>([])
const golferScores = ref<GolferScore[]>([])
const golfers = ref<Golfer[]>([])

// ─── Chat State ───
const messages = ref<MessageWithMeta[]>([])
const profileMap = ref<Map<string, string>>(new Map())
const newMessage = ref('')
const feedRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const chatLoading = ref(false)
const hasMore = ref(true)
const userScrolledUp = ref(false)
const PAGE_SIZE = 50

// ─── Countdown ───
const countdown = ref({ days: 0, hours: 0, minutes: 0, seconds: 0 })
let countdownInterval: ReturnType<typeof setInterval> | null = null
const DRAFT_DATE = new Date('2026-04-07T00:00:00Z') // April 6, 6:00 PM MDT (UTC-6)

// ─── Realtime ───
const channels: RealtimeChannel[] = []

// ─── Computed ───
const tournamentStatus = computed(() => tournament.value?.status ?? 'pre-draft')

const currentUserReady = computed(() => {
  if (!auth.user) return false
  return readyChecks.value.find(rc => rc.user_id === auth.user!.id)?.is_ready ?? false
})

const notReadyPlayers = computed(() => {
  const readyIds = new Set(readyChecks.value.filter(rc => rc.is_ready).map(rc => rc.user_id))
  return profiles.value.filter(p => !readyIds.has(p.id))
})

const isPlayerReady = (playerId: string) => {
  return readyChecks.value.find(rc => rc.user_id === playerId)?.is_ready ?? false
}

const allReady = computed(() => {
  if (profiles.value.length === 0) return false
  return profiles.value.every(p => readyChecks.value.some(rc => rc.user_id === p.id && rc.is_ready))
})

const currentPickUser = computed(() => {
  if (!draftState.value || draftState.value.status !== 'drafting') return null
  const userId = draftState.value.draft_order[draftState.value.current_pick_index]
  return profiles.value.find(p => p.id === userId)
})

const userPicks = computed(() => {
  if (!auth.user) return []
  return draftPicks.value
    .filter(dp => dp.user_id === auth.user!.id)
    .map(dp => {
      const golfer = golfers.value.find(g => g.id === dp.golfer_id)
      const score = golferScores.value.find(gs => gs.golfer_id === dp.golfer_id)
      return { ...dp, golfer, score }
    })
})

const playerStandings = computed(() => {
  const results: { userId: string; name: string; totalToPar: number | null }[] = []
  for (const profile of profiles.value) {
    const playerPicks = draftPicks.value.filter(dp => dp.user_id === profile.id)
    const activeScores = playerPicks
      .map(pick => golferScores.value.find(gs => gs.golfer_id === pick.golfer_id))
      .filter(score => score && (score.status === 'active' || score.to_par == null))
      .filter(score => score?.to_par != null)
      .sort((a, b) => a!.to_par! - b!.to_par!)
    const best2 = activeScores.slice(0, 2)
    const total = best2.length > 0 ? best2.reduce((sum, s) => sum + s!.to_par!, 0) : null
    results.push({ userId: profile.id, name: profile.display_name, totalToPar: total })
  }
  return results.sort((a, b) => (a.totalToPar ?? 999) - (b.totalToPar ?? 999))
})

const topThree = computed(() => playerStandings.value.slice(0, 3))
const winner = computed(() => playerStandings.value[0] ?? null)

// ─── Helpers ───
function formatScore(toPar: number | null): string {
  if (toPar == null) return '--'
  if (toPar === 0) return 'E'
  return toPar > 0 ? `+${toPar}` : `${toPar}`
}

function updateCountdown() {
  const diff = Math.max(0, DRAFT_DATE.getTime() - Date.now())
  countdown.value = {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
    minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
    seconds: Math.floor((diff % (1000 * 60)) / 1000),
  }
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)
  if (diffMin < 1) return 'just now'
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
    if (existing) { existing.count++; existing.userIds.push(r.user_id) }
    else { map.set(r.emoji, { count: 1, userIds: [r.user_id] }) }
  }
  return Array.from(map.entries()).map(([emoji, data]) => ({ emoji, count: data.count, userIds: data.userIds }))
}

// ─── Tournament Actions ───
const startingDraft = ref(false)

async function toggleReady() {
  if (!auth.user || !tournament.value || togglingReady.value) return
  togglingReady.value = true
  const newReady = !currentUserReady.value
  try {
    const { error } = await supabase.from('ready_checks').upsert(
      { tournament_id: tournament.value.id, user_id: auth.user.id, is_ready: newReady },
      { onConflict: 'tournament_id,user_id' }
    )
    if (error) { console.error('toggleReady failed:', error); return }
    if (newReady) {
      const { data: checks } = await supabase.from('ready_checks').select('*').eq('tournament_id', tournament.value.id)
      const { data: allProfiles } = await supabase.from('profiles').select('id')
      if (checks && allProfiles) {
        const everyoneReady = allProfiles.every(p => checks.some(c => c.user_id === p.id && c.is_ready))
        if (everyoneReady && allProfiles.length >= 1) await startDraft()
      }
    }
  } finally { togglingReady.value = false }
}

async function toggleReadyFor(userId: string) {
  if (!tournament.value) return
  const current = readyChecks.value.find(rc => rc.user_id === userId)
  const { error } = await supabase.from('ready_checks').upsert(
    { tournament_id: tournament.value.id, user_id: userId, is_ready: !(current?.is_ready) },
    { onConflict: 'tournament_id,user_id' }
  )
  if (error) { console.error('toggleReadyFor failed:', error); return }
  const { data } = await supabase.from('ready_checks').select('*').eq('tournament_id', tournament.value.id)
  if (data) readyChecks.value = data
}

async function startDraft() {
  if (!tournament.value || startingDraft.value) return
  startingDraft.value = true
  try {
    const { error } = await supabase.rpc('start_draft', { p_tournament_id: tournament.value.id })
    if (error) { console.error('Failed to start draft:', error); alert('Failed to start draft: ' + error.message) }
  } finally { startingDraft.value = false }
}

// ─── Chat Actions ───
async function fetchMessages(before?: string) {
  chatLoading.value = true
  let query = supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(PAGE_SIZE)
  if (before) query = query.lt('created_at', before)

  const { data: msgs } = await query
  if (!msgs) { chatLoading.value = false; return }
  if (msgs.length < PAGE_SIZE) hasMore.value = false

  const messageIds = msgs.map(m => m.id)
  let reactions: MessageReaction[] = []
  if (messageIds.length > 0) {
    const { data: reactionsData } = await supabase.from('message_reactions').select('*').in('message_id', messageIds)
    reactions = reactionsData || []
  }

  const reactionsByMessage = new Map<string, MessageReaction[]>()
  for (const r of reactions) {
    const existing = reactionsByMessage.get(r.message_id) || []
    existing.push(r)
    reactionsByMessage.set(r.message_id, existing)
  }

  const enriched: MessageWithMeta[] = msgs.map(m => ({
    ...m,
    reactions: groupReactions(reactionsByMessage.get(m.id) || []),
    senderName: profileMap.value.get(m.user_id) || 'Unknown',
  }))
  enriched.reverse()

  if (before) { messages.value = [...enriched, ...messages.value] }
  else { messages.value = enriched }
  chatLoading.value = false
}

async function loadMore() {
  if (!messages.value.length || !hasMore.value) return
  await fetchMessages(messages.value[0].created_at)
}

async function sendMessage() {
  if (!newMessage.value.trim() || !auth.user) return
  const content = newMessage.value.trim()
  newMessage.value = ''
  if (inputRef.value) inputRef.value.style.height = 'auto'
  const { error } = await supabase.from('messages').insert({ user_id: auth.user.id, content })
  if (error) { newMessage.value = content; console.error('Failed to send:', error) }
}

function handleChatKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
}

function handleChatInput(e: Event) {
  const target = e.target as HTMLTextAreaElement
  target.style.height = 'auto'
  target.style.height = Math.min(target.scrollHeight, 80) + 'px'
}

function handleScroll() {
  if (!feedRef.value) return
  const el = feedRef.value
  userScrolledUp.value = (el.scrollHeight - el.scrollTop - el.clientHeight) > 100
}

function scrollToBottom() {
  nextTick(() => { if (feedRef.value) feedRef.value.scrollTop = feedRef.value.scrollHeight })
}

// ─── Data Fetching ───
async function fetchData() {
  loading.value = true

  const { data: t } = await supabase.from('tournaments').select('*').eq('year', 2026).single()
  tournament.value = t
  if (!t) { loading.value = false; return }

  const [draftRes, readyRes, profilesRes, golferCountRes] = await Promise.all([
    supabase.from('draft_state').select('*').eq('tournament_id', t.id).single(),
    supabase.from('ready_checks').select('*').eq('tournament_id', t.id),
    supabase.from('profiles').select('*'),
    supabase.from('golfers').select('id', { count: 'exact', head: true }).eq('is_active', true),
  ])

  draftState.value = draftRes.data as unknown as DraftState | null
  readyChecks.value = readyRes.data ?? []
  profiles.value = profilesRes.data ?? []
  golferCount.value = golferCountRes.count ?? 0

  // Build profile map for chat
  for (const p of profiles.value) { profileMap.value.set(p.id, p.display_name) }

  if (t.status === 'in-progress' || t.status === 'completed') {
    const [picksRes, scoresRes, golfersRes] = await Promise.all([
      supabase.from('draft_picks').select('*').eq('tournament_id', t.id),
      supabase.from('golfer_scores').select('*').eq('tournament_id', t.id),
      supabase.from('golfers').select('*').eq('is_active', true),
    ])
    draftPicks.value = picksRes.data ?? []
    golferScores.value = scoresRes.data ?? []
    golfers.value = golfersRes.data ?? []
  }

  loading.value = false
}

// ─── Realtime Subscriptions ───
function setupRealtimeSubscriptions() {
  if (!tournament.value) return

  const tournamentChannel = supabase
    .channel('dashboard-tournaments')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${tournament.value.id}` },
      (payload) => { tournament.value = payload.new as Tournament })
    .subscribe()
  channels.push(tournamentChannel)

  const draftChannel = supabase
    .channel('dashboard-draft-state')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_state', filter: `tournament_id=eq.${tournament.value.id}` },
      (payload) => { draftState.value = payload.new as DraftState })
    .subscribe()
  channels.push(draftChannel)

  const readyChannel = supabase
    .channel('dashboard-ready-checks')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ready_checks', filter: `tournament_id=eq.${tournament.value.id}` },
      async () => {
        const { data } = await supabase.from('ready_checks').select('*').eq('tournament_id', tournament.value!.id)
        readyChecks.value = data ?? []
      })
    .subscribe()
  channels.push(readyChannel)

  const scoresChannel = supabase
    .channel('dashboard-scores')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'golfer_scores', filter: `tournament_id=eq.${tournament.value.id}` },
      async () => {
        const { data } = await supabase.from('golfer_scores').select('*').eq('tournament_id', tournament.value!.id)
        golferScores.value = data ?? []
      })
    .subscribe()
  channels.push(scoresChannel)

  // Chat realtime
  const messagesChannel = supabase
    .channel('dashboard-messages')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => {
        const newMsg = payload.new as Message
        if (messages.value.some(m => m.id === newMsg.id)) return
        messages.value.push({
          ...newMsg,
          reactions: [],
          senderName: profileMap.value.get(newMsg.user_id) || 'Unknown',
        })
        if (!userScrolledUp.value) scrollToBottom()
      })
    .subscribe()
  channels.push(messagesChannel)

  const reactionsChannel = supabase
    .channel('dashboard-reactions')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' },
      (payload) => {
        const reaction = payload.new as MessageReaction
        if (reaction.user_id === auth.user?.id) return
        const msg = messages.value.find(m => m.id === reaction.message_id)
        if (!msg) return
        const group = msg.reactions.find(r => r.emoji === reaction.emoji)
        if (group) { if (!group.userIds.includes(reaction.user_id)) { group.userIds.push(reaction.user_id); group.count++ } }
        else { msg.reactions.push({ emoji: reaction.emoji, count: 1, userIds: [reaction.user_id] }) }
      })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' },
      (payload) => {
        const reaction = payload.old as MessageReaction
        if (reaction.user_id === auth.user?.id) return
        const msg = messages.value.find(m => m.id === reaction.message_id)
        if (!msg) return
        const group = msg.reactions.find(r => r.emoji === reaction.emoji)
        if (group) {
          group.userIds = group.userIds.filter(id => id !== reaction.user_id)
          group.count--
          if (group.count === 0) msg.reactions = msg.reactions.filter(r => r.emoji !== reaction.emoji)
        }
      })
    .subscribe()
  channels.push(reactionsChannel)
}

function cleanup() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
  channels.forEach(ch => supabase.removeChannel(ch))
  channels.length = 0
}

onMounted(async () => {
  await fetchData()
  setupRealtimeSubscriptions()
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
  updateCountdown()
  countdownInterval = setInterval(updateCountdown, 1000)
  // Load chat
  chatStore.reset()
  await fetchMessages()
  scrollToBottom()
})

onUnmounted(() => { cleanup() })
</script>

<template>
  <div class="p-4 sm:p-6 lg:p-8 max-w-lg md:max-w-2xl mx-auto space-y-5 pb-24">
    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-augusta border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- ==================== HEADER ==================== -->
      <div class="text-center pt-2">
        <img src="/masters-logo.png" alt="Masters" class="h-10 mx-auto mb-2" />
        <h1 class="text-2xl font-bold text-dark">The Morrison Open</h1>
        <p class="text-gray-500 text-sm mt-0.5">Welcome, {{ auth.displayName }}</p>
      </div>

      <!-- ==================== PRE-DRAFT ==================== -->
      <template v-if="tournamentStatus === 'pre-draft'">
        <!-- Countdown -->
        <div class="bg-augusta-gradient rounded-2xl p-5 text-center shadow-lg">
          <p class="text-cream/80 text-xs font-medium uppercase tracking-wider mb-2">Draft Night Countdown</p>
          <div class="flex justify-center gap-2">
            <div v-for="(val, key) in countdown" :key="key" class="bg-black/30 rounded-xl px-3 py-2.5 min-w-[52px]">
              <span class="text-2xl font-bold text-gold-glow font-score">{{ String(val).padStart(2, '0') }}</span>
              <p class="text-cream/60 text-[10px] uppercase mt-0.5">{{ key }}</p>
            </div>
          </div>
          <p class="text-cream/70 mt-3 text-xs">Monday, April 6 &middot; 6:00 PM MDT</p>
        </div>

        <!-- Players & Ready -->
        <div class="bg-white rounded-2xl shadow-md p-4">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-bold text-dark text-base">Players</h2>
            <span class="text-xs text-gray-400">{{ profiles.length - notReadyPlayers.length }}/{{ profiles.length }} ready</span>
          </div>
          <div class="space-y-1.5">
            <button
              v-for="profile in profiles"
              :key="profile.id"
              @click="profile.id === auth.user?.id ? toggleReady() : toggleReadyFor(profile.id)"
              class="w-full flex items-center justify-between py-2 px-3 rounded-lg transition-colors min-h-[40px]"
              :class="isPlayerReady(profile.id) ? 'bg-green-50 hover:bg-green-100' : 'bg-gray-50 hover:bg-gray-100'"
            >
              <div class="flex items-center gap-2">
                <span
                  class="w-5 h-5 rounded-full flex items-center justify-center text-xs flex-shrink-0"
                  :class="isPlayerReady(profile.id) ? 'bg-green-500 text-white' : 'bg-gray-300 text-white'"
                >
                  <template v-if="isPlayerReady(profile.id)">&#10003;</template>
                </span>
                <span class="font-medium text-dark text-sm">{{ profile.display_name }}</span>
                <span
                  v-if="profile.id === auth.user?.id"
                  class="text-[9px] bg-augusta/10 text-augusta px-1.5 py-0.5 rounded-full font-semibold uppercase"
                >You</span>
              </div>
              <span v-if="isPlayerReady(profile.id)" class="text-green-500 font-bold text-xs">Ready</span>
              <span v-else class="text-gray-400 text-xs">Tap to ready</span>
            </button>
          </div>

          <p v-if="notReadyPlayers.length > 0" class="text-gray-400 text-xs mt-2.5">
            Waiting for: {{ notReadyPlayers.map(p => p.display_name).join(', ') }}
          </p>
          <p v-else class="text-green-600 text-xs mt-2.5 font-medium">All players ready!</p>
        </div>

        <!-- Start Draft -->
        <button
          v-if="allReady && profiles.length >= 1"
          @click="startDraft"
          :disabled="startingDraft"
          class="w-full py-3 rounded-xl font-bold text-white text-base bg-augusta-gradient shadow-lg active:scale-95 transition-all"
        >
          <span v-if="startingDraft" class="animate-pulse">Starting Draft...</span>
          <span v-else>Start the Draft!</span>
        </button>

        <!-- Quick Links -->
        <div class="flex gap-3">
          <router-link
            to="/golfers"
            class="flex-1 bg-white rounded-xl shadow-md p-3 text-center hover:shadow-lg transition-shadow"
          >
            <p class="text-xl">&#9971;</p>
            <p class="text-dark font-bold text-sm mt-1">{{ golferCount }} Golfers</p>
            <p class="text-gray-400 text-[10px]">View the field</p>
          </router-link>
          <router-link
            to="/draft"
            class="flex-1 bg-white rounded-xl shadow-md p-3 text-center hover:shadow-lg transition-shadow"
          >
            <p class="text-xl">&#128203;</p>
            <p class="text-dark font-bold text-sm mt-1">Draft Room</p>
            <p class="text-gray-400 text-[10px]">Join the draft</p>
          </router-link>
        </div>
      </template>

      <!-- ==================== DRAFT IN PROGRESS ==================== -->
      <template v-else-if="tournamentStatus === 'draft'">
        <div class="bg-augusta-gradient rounded-2xl px-6 py-5 text-center shadow-lg">
          <h2 class="text-2xl font-bold text-gold-glow animate-pulse font-score tracking-wider">DRAFT IN PROGRESS!</h2>
          <p v-if="currentPickUser" class="text-cream/80 text-sm mt-2">
            Currently picking: <span class="text-white font-bold">{{ currentPickUser.display_name }}</span>
          </p>
          <p class="text-cream/60 text-xs mt-1">
            Pick {{ (draftState?.current_pick_index ?? 0) + 1 }} of {{ draftState?.draft_order?.length ?? 0 }}
          </p>
        </div>
        <router-link
          to="/draft"
          class="block w-full py-3.5 rounded-xl font-bold text-white text-lg text-center bg-gold shadow-lg active:scale-95 transition-transform"
        >
          Join the Draft &rarr;
        </router-link>
      </template>

      <!-- ==================== IN PROGRESS ==================== -->
      <template v-else-if="tournamentStatus === 'in-progress'">
        <div class="bg-augusta-gradient rounded-2xl px-5 py-4 text-center shadow-lg">
          <h2 class="text-lg font-bold text-gold-glow font-score tracking-wider">
            THE MASTERS &ndash; ROUND {{ tournament?.current_round ?? '?' }}
          </h2>
        </div>

        <!-- Mini Leaderboard -->
        <div class="bg-white rounded-2xl shadow-md p-4">
          <h2 class="font-bold text-dark text-base mb-2">Leaderboard</h2>
          <div class="space-y-1.5">
            <div
              v-for="(standing, idx) in topThree"
              :key="standing.userId"
              class="flex items-center justify-between py-2 px-3 rounded-xl"
              :class="idx === 0 ? 'bg-gold/10' : 'bg-gray-50'"
            >
              <div class="flex items-center gap-2.5">
                <span class="text-lg font-bold font-score w-5 text-center" :class="idx === 0 ? 'text-gold' : 'text-gray-400'">{{ idx + 1 }}</span>
                <span class="font-medium text-dark text-sm">{{ standing.name }}</span>
              </div>
              <span class="font-bold font-score" :class="(standing.totalToPar ?? 0) < 0 ? 'text-red-600' : 'text-gray-600'">
                {{ formatScore(standing.totalToPar) }}
              </span>
            </div>
          </div>
          <router-link to="/leaderboard" class="block text-center text-augusta font-semibold text-xs mt-3 hover:underline">
            See Full Leaderboard &rarr;
          </router-link>
        </div>

        <!-- Your Team -->
        <div class="bg-white rounded-2xl shadow-md p-4">
          <h2 class="font-bold text-dark text-base mb-2">Your Team</h2>
          <div v-if="userPicks.length === 0" class="text-gray-400 text-sm">No picks found.</div>
          <div v-else class="space-y-1.5">
            <div v-for="pick in userPicks" :key="pick.id" class="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-xl">
              <div>
                <p class="font-medium text-dark text-sm">{{ pick.golfer?.name ?? 'Unknown' }}</p>
                <p class="text-[10px] text-gray-400">{{ pick.score?.position ?? '--' }} &middot; Thru {{ pick.score?.thru ?? '--' }}</p>
              </div>
              <span class="font-bold font-score" :class="(pick.score?.to_par ?? 0) < 0 ? 'text-red-600' : 'text-gray-600'">
                {{ pick.score?.to_par != null ? formatScore(pick.score.to_par) : '--' }}
              </span>
            </div>
          </div>
          <router-link to="/my-team" class="block text-center text-augusta font-semibold text-xs mt-3 hover:underline">
            View Full Team &rarr;
          </router-link>
        </div>
      </template>

      <!-- ==================== COMPLETED ==================== -->
      <template v-else-if="tournamentStatus === 'completed'">
        <div class="text-center space-y-1">
          <p class="text-4xl">&#127942;</p>
          <h2 class="text-xl font-bold text-dark">Winner: {{ winner?.name ?? 'TBD' }}</h2>
          <p v-if="winner" class="text-augusta font-bold font-score text-lg">{{ formatScore(winner.totalToPar) }}</p>
        </div>
        <div class="bg-white rounded-2xl shadow-md p-4">
          <h2 class="font-bold text-dark text-base mb-2">Final Standings</h2>
          <div class="space-y-1.5">
            <div
              v-for="(standing, idx) in playerStandings"
              :key="standing.userId"
              class="flex items-center justify-between py-2 px-3 rounded-xl"
              :class="idx === 0 ? 'bg-gold/10' : 'bg-gray-50'"
            >
              <div class="flex items-center gap-2.5">
                <span class="text-lg font-bold font-score w-5 text-center" :class="idx === 0 ? 'text-gold' : 'text-gray-400'">{{ idx + 1 }}</span>
                <span class="font-medium text-dark text-sm">{{ standing.name }}</span>
              </div>
              <span class="font-bold font-score" :class="(standing.totalToPar ?? 0) < 0 ? 'text-red-600' : 'text-gray-600'">
                {{ formatScore(standing.totalToPar) }}
              </span>
            </div>
          </div>
        </div>
        <router-link to="/leaderboard" class="block w-full py-3.5 rounded-xl font-bold text-white text-lg text-center bg-augusta-gradient shadow-lg active:scale-95 transition-transform">
          See Full Results &rarr;
        </router-link>
      </template>

      <!-- ==================== CHAT ==================== -->
      <div class="bg-white rounded-2xl shadow-md overflow-hidden">
        <div class="bg-augusta px-4 py-2.5 flex items-center justify-between">
          <h2 class="text-white font-bold text-sm tracking-tight">Chat</h2>
          <span class="text-white/60 text-xs">{{ messages.length }} messages</span>
        </div>

        <!-- Messages Feed -->
        <div
          ref="feedRef"
          class="h-72 overflow-y-auto px-3 py-2 space-y-2.5 bg-cream/30"
          @scroll="handleScroll"
        >
          <!-- Load More -->
          <div v-if="hasMore" class="text-center">
            <button
              class="text-xs text-augusta hover:underline font-medium px-3 py-1 bg-white rounded-full shadow-sm"
              :disabled="chatLoading"
              @click="loadMore"
            >{{ chatLoading ? 'Loading...' : 'Load older messages' }}</button>
          </div>

          <!-- Messages -->
          <div
            v-for="msg in messages"
            :key="msg.id"
            class="flex flex-col"
            :class="msg.user_id === auth.user?.id ? 'items-end' : 'items-start'"
          >
            <span class="text-[10px] font-bold mb-0.5 px-1" :class="msg.user_id === auth.user?.id ? 'text-augusta-dark' : 'text-dark/50'">
              {{ msg.senderName }}
            </span>
            <div class="max-w-[80%]">
              <div
                class="px-3 py-1.5 rounded-2xl text-sm leading-relaxed break-words"
                :class="msg.user_id === auth.user?.id
                  ? 'bg-augusta text-white rounded-br-md'
                  : 'bg-white text-dark rounded-bl-md shadow-sm'"
                v-html="renderContent(msg.content)"
              />
              <!-- Reactions -->
              <div v-if="msg.reactions.length > 0" class="flex flex-wrap gap-0.5 mt-0.5" :class="msg.user_id === auth.user?.id ? 'justify-end' : 'justify-start'">
                <span
                  v-for="reaction in msg.reactions"
                  :key="reaction.emoji"
                  class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full text-[10px] bg-white border border-gray-100"
                >
                  <span>{{ reaction.emoji }}</span>
                  <span class="font-medium text-dark/60">{{ reaction.count }}</span>
                </span>
              </div>
            </div>
            <span class="text-[9px] text-dark/30 mt-0.5 px-1">{{ formatTimestamp(msg.created_at) }}</span>
          </div>

          <div v-if="messages.length === 0 && !chatLoading" class="text-center py-8 text-gray-400 text-sm">
            No messages yet. Start the conversation!
          </div>
        </div>

        <!-- Input -->
        <div class="border-t border-gray-100 px-3 py-2 flex items-end gap-2">
          <textarea
            ref="inputRef"
            v-model="newMessage"
            placeholder="Send a message..."
            rows="1"
            class="flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm min-h-[38px] focus:outline-none focus:border-augusta focus:ring-1 focus:ring-augusta/30 bg-cream/30 placeholder-dark/30"
            style="max-height: 72px"
            @keydown="handleChatKeydown"
            @input="handleChatInput"
          />
          <button
            class="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all"
            :class="newMessage.trim() ? 'bg-gold text-white shadow-sm' : 'bg-gray-200 text-gray-400 cursor-not-allowed'"
            :disabled="!newMessage.trim()"
            @click="sendMessage"
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>

        <!-- Link to full chat -->
        <router-link to="/chat" class="block text-center text-augusta text-xs font-medium py-2 border-t border-gray-50 hover:bg-augusta/5 transition-colors">
          Open Full Chat &rarr;
        </router-link>
      </div>
    </template>
  </div>
</template>
