<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'

import type { Database } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Tournament = Database['public']['Tables']['tournaments']['Row']
type DraftPick = Database['public']['Tables']['draft_picks']['Row']
type Golfer = Database['public']['Tables']['golfers']['Row']
type GolferScore = Database['public']['Tables']['golfer_scores']['Row']
type Profile = Database['public']['Tables']['profiles']['Row']
type Message = Database['public']['Tables']['messages']['Row']
type MessageReaction = Database['public']['Tables']['message_reactions']['Row']

interface ReactionGroup { emoji: string; count: number; userIds: string[] }
interface MessageWithMeta extends Message { reactions: ReactionGroup[]; senderName: string }

interface DraftState {
  id: string
  tournament_id: string
  status: string
  draft_order: string[]  // array of user UUIDs in snake order
  current_pick_index: number
  pick_deadline: string | null
  created_at: string
}

const auth = useAuthStore()

// Core data
const tournament = ref<Tournament | null>(null)
const draftState = ref<DraftState | null>(null)
const draftPicks = ref<DraftPick[]>([])
const golfers = ref<Golfer[]>([])
const profiles = ref<Profile[]>([])
const loading = ref(true)

// Tournament home state (for completed/in-progress)
const chatStore = useChatStore()
const golferScores = ref<GolferScore[]>([])
const chatMessages = ref<MessageWithMeta[]>([])
const chatProfileMap = ref<Map<string, string>>(new Map())
const newChatMessage = ref('')
const chatFeedRef = ref<HTMLElement | null>(null)
const chatInputRef = ref<HTMLTextAreaElement | null>(null)
const chatUserScrolledUp = ref(false)

// Craig roast modal — show once per session until April 11
const showCraigRoast = ref(false)
function checkCraigRoast() {
  const now = new Date()
  const expiry = new Date('2026-04-11T00:00:00Z')
  if (now < expiry && !sessionStorage.getItem('craig-roast-dismissed')) {
    showCraigRoast.value = true
  }
}
function dismissCraigRoast() {
  showCraigRoast.value = false
  sessionStorage.setItem('craig-roast-dismissed', '1')
}

function formatToPar(n: number | null): string {
  if (n == null) return '--'
  if (n === 0) return 'E'
  return n > 0 ? `+${n}` : `${n}`
}

function chatFormatTimestamp(dateStr: string): string {
  const diffMin = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function chatEscapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function chatRenderContent(content: string): string {
  return chatEscapeHtml(content).replace(/@(\w[\w\s]*?\w|\w)/g, '<span class="bg-gold/20 text-augusta font-semibold px-0.5 rounded">@$1</span>')
}

const playerStandings = computed(() => {
  const results: { userId: string; name: string; totalToPar: number | null }[] = []
  for (const profile of profiles.value) {
    const playerPicks = draftPicks.value.filter(dp => dp.user_id === profile.id)
    const activeScores = playerPicks
      .map(pick => golferScores.value.find(gs => gs.golfer_id === pick.golfer_id))
      .filter((score): score is GolferScore => score != null && score.status?.toLowerCase() === 'active')
      .filter(score => score.to_par != null)
      .sort((a, b) => (a.to_par ?? 999) - (b.to_par ?? 999))
    const best2 = activeScores.slice(0, 2)
    const total = best2.length > 0 ? best2.reduce((sum, s) => sum + (s.to_par ?? 0), 0) : null
    results.push({ userId: profile.id, name: profile.display_name, totalToPar: total })
  }
  return results.sort((a, b) => (a.totalToPar ?? 999) - (b.totalToPar ?? 999))
})

const myTeamWithScores = computed(() => {
  if (!auth.user) return []
  const picks = draftPicks.value
    .filter(dp => dp.user_id === auth.user!.id)
    .map(dp => {
      const golfer = golfers.value.find(g => g.id === dp.golfer_id)
      const score = golferScores.value.find(gs => gs.golfer_id === dp.golfer_id) ?? null
      return { ...dp, golfer, score }
    })
  picks.sort((a, b) => (a.score?.to_par ?? 999) - (b.score?.to_par ?? 999))
  return picks
})

async function sendChatMessage() {
  if (!newChatMessage.value.trim() || !auth.user) return
  const content = newChatMessage.value.trim()
  newChatMessage.value = ''
  if (chatInputRef.value) chatInputRef.value.style.height = 'auto'
  const { error } = await supabase.from('messages').insert({ user_id: auth.user.id, content })
  if (error) { newChatMessage.value = content; console.error('Failed to send:', error) }
}

function handleChatKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage() }
}

function handleChatInput(e: Event) {
  const target = e.target as HTMLTextAreaElement
  target.style.height = 'auto'
  target.style.height = Math.min(target.scrollHeight, 80) + 'px'
}

function handleChatScroll() {
  if (!chatFeedRef.value) return
  const el = chatFeedRef.value
  chatUserScrolledUp.value = (el.scrollHeight - el.scrollTop - el.clientHeight) > 100
}

function scrollChatToBottom() {
  nextTick(() => { if (chatFeedRef.value) chatFeedRef.value.scrollTop = chatFeedRef.value.scrollHeight })
}

// UI state
const searchQuery = ref('')
const selectedGolfer = ref<Golfer | null>(null)
const pickLoading = ref(false)
const pickError = ref('')
const golferSortBy = ref<'ranking' | 'name'>('ranking')

// Pick announcement
const pickAnnouncement = ref<{ playerName: string; golferName: string; golferImage: string | null; pickNumber: number; nextPlayerName: string | null } | null>(null)

// Lottery animation
const showLottery = ref(false)
const lotteryComplete = ref(false)
const currentLotteryIndex = ref(-1)

// Proxy drafting - admin mode
const adminMode = ref(false)
const proxyPlayerIds = ref<Set<string>>(new Set(
  JSON.parse(localStorage.getItem('morrison-proxy-ids') || '[]')
))
const proxyName = ref('')
const addingProxy = ref(false)

function saveProxyIds() {
  localStorage.setItem('morrison-proxy-ids', JSON.stringify([...proxyPlayerIds.value]))
}


async function addProxyPlayer() {
  if (!proxyName.value.trim() || addingProxy.value || !tournament.value) return
  addingProxy.value = true
  try {
    const { data: newId, error } = await supabase.rpc('create_proxy_player', {
      p_display_name: proxyName.value.trim(),
      p_tournament_id: tournament.value.id,
    })
    if (error) {
      console.error('Failed to add player:', error)
      alert('Failed to add player: ' + error.message)
      return
    }
    if (newId) {
      proxyPlayerIds.value.add(newId as string)
      saveProxyIds()
    }
    proxyName.value = ''
    // Refresh profiles and ready checks
    const [profilesRes, readyRes] = await Promise.all([
      supabase.from('profiles').select('*'),
      supabase.from('ready_checks').select('*').eq('tournament_id', tournament.value.id),
    ])
    if (profilesRes.data) profiles.value = profilesRes.data
    if (readyRes.data) readyChecks.value = readyRes.data
  } finally {
    addingProxy.value = false
  }
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

// Ready check state
type ReadyCheck = Database['public']['Tables']['ready_checks']['Row']
const readyChecks = ref<ReadyCheck[]>([])
const togglingReady = ref(false)
const startingDraft = ref(false)

// Countdown
const countdown = ref({ days: 0, hours: 0, minutes: 0, seconds: 0 })
let countdownInterval: ReturnType<typeof setInterval> | null = null
const DRAFT_DATE = new Date('2026-04-07T00:00:00Z') // April 6, 6:00 PM MDT (UTC-6)

const currentUserReady = computed(() => {
  if (!auth.user) return false
  return readyChecks.value.find(rc => rc.user_id === auth.user!.id)?.is_ready ?? false
})

const allReady = computed(() => {
  if (profiles.value.length === 0) return false
  return profiles.value.every(p =>
    readyChecks.value.some(rc => rc.user_id === p.id && rc.is_ready)
  )
})

const notReadyPlayers = computed(() => {
  const readyIds = new Set(readyChecks.value.filter(rc => rc.is_ready).map(rc => rc.user_id))
  return profiles.value.filter(p => !readyIds.has(p.id))
})

function isPlayerReady(playerId: string) {
  return readyChecks.value.find(rc => rc.user_id === playerId)?.is_ready ?? false
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
    // After the upsert, check if we should auto-start
    if (newReady) {
      const { data: checks } = await supabase
        .from('ready_checks')
        .select('*')
        .eq('tournament_id', tournament.value!.id)
      const allProfilesReady = profiles.value.every(p =>
        checks?.some(c => c.user_id === p.id && c.is_ready)
      )
      if (allProfilesReady && profiles.value.length >= 1) {
        await startDraft()
      }
    }
  } finally {
    togglingReady.value = false
  }
}

async function startDraft() {
  if (!tournament.value || startingDraft.value) return
  startingDraft.value = true
  try {
    const { error } = await supabase.rpc('start_draft', { p_tournament_id: tournament.value.id })
    if (error) alert('Failed to start draft: ' + error.message)
  } finally {
    startingDraft.value = false
  }
}

// Timer
const timerSeconds = ref(0)
const timerExpiredHandled = ref(false)
let timerInterval: ReturnType<typeof setInterval> | null = null

// Google Meet link — create one at https://meet.google.com and paste it here
const MEET_LINK = 'https://meet.google.com/bjh-mhdh-svv'

// Realtime channels
const channels: RealtimeChannel[] = []

// Track if we already notified for the current pick
let lastNotifiedPickIndex = -1

// ─── Computed ───

const numPlayers = computed(() => {
  return draftState.value?.draft_order?.length
    ? new Set(draftState.value.draft_order).size
    : 0
})

const totalPicks = computed(() => draftState.value?.draft_order?.length ?? 0)

const picksPerPlayer = computed(() => {
  if (!numPlayers.value) return 4
  return Math.floor(totalPicks.value / numPlayers.value)
})

const currentRound = computed(() => {
  if (!draftState.value || !numPlayers.value) return 1
  return Math.floor(draftState.value.current_pick_index / numPlayers.value) + 1
})

const totalRounds = computed(() => picksPerPlayer.value)

const currentPickUserId = computed(() => {
  if (!draftState.value) return null
  return draftState.value.draft_order[draftState.value.current_pick_index] ?? null
})

const currentPickUser = computed(() => {
  if (!currentPickUserId.value) return null
  return profiles.value.find(p => p.id === currentPickUserId.value) ?? null
})

const isMyTurn = computed(() => {
  return auth.user?.id === currentPickUserId.value && draftState.value?.status === 'drafting'
})

const canPick = computed(() => {
  if (!draftState.value || draftState.value.status !== 'drafting') return false
  if (adminMode.value) return true
  return isMyTurn.value
})

const profileMap = computed(() => {
  const map = new Map<string, Profile>()
  profiles.value.forEach(p => map.set(p.id, p))
  return map
})

const golferMap = computed(() => {
  const map = new Map<string, Golfer>()
  golfers.value.forEach(g => map.set(g.id, g))
  return map
})

const draftedGolferIds = computed(() => {
  return new Set(draftPicks.value.map(dp => dp.golfer_id))
})

const availableGolfers = computed(() => {
  return golfers.value
    .filter(g => !draftedGolferIds.value.has(g.id))
    .sort((a, b) => a.world_ranking - b.world_ranking)
})

const sortedAvailableGolfers = computed(() => {
  let list = availableGolfers.value
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase().trim()
    list = list.filter(g =>
      g.name.toLowerCase().includes(q) ||
      g.country.toLowerCase().includes(q)
    )
  }
  if (golferSortBy.value === 'ranking') {
    return [...list].sort((a, b) => (a.power_ranking ?? 999) - (b.power_ranking ?? 999))
  } else {
    return [...list].sort((a, b) => {
      const lastA = a.name.split(' ').pop() || ''
      const lastB = b.name.split(' ').pop() || ''
      return lastA.localeCompare(lastB)
    })
  }
})

const myPicks = computed(() => {
  if (!auth.user) return []
  return draftPicks.value
    .filter(dp => dp.user_id === auth.user!.id)
    .sort((a, b) => a.pick_number - b.pick_number)
    .map(dp => ({
      ...dp,
      golfer: golferMap.value.get(dp.golfer_id),
    }))
})

// Group picks and placeholders by round for the draft board
const draftBoard = computed(() => {
  if (!draftState.value || !numPlayers.value) return []
  const rounds: Array<{
    round: number
    reversed: boolean
    slots: Array<{
      pickNumber: number
      userId: string
      userName: string
      golfer: Golfer | null
      isCurrent: boolean
      isPicked: boolean
    }>
  }> = []

  const order = draftState.value.draft_order
  const pickMap = new Map<number, DraftPick>()
  draftPicks.value.forEach(dp => pickMap.set(dp.pick_number, dp))

  for (let r = 0; r < totalRounds.value; r++) {
    const reversed = r % 2 === 1
    const slots = []
    for (let s = 0; s < numPlayers.value; s++) {
      const pickIndex = r * numPlayers.value + s
      const userId = order[pickIndex]
      const pick = pickMap.get(pickIndex + 1) // pick_number is 1-based
      slots.push({
        pickNumber: pickIndex + 1,
        userId,
        userName: profileMap.value.get(userId)?.display_name ?? 'Unknown',
        golfer: pick ? golferMap.value.get(pick.golfer_id) ?? null : null,
        isCurrent: pickIndex === draftState.value!.current_pick_index && draftState.value!.status === 'drafting',
        isPicked: !!pick,
      })
    }
    rounds.push({ round: r + 1, reversed, slots })
  }

  return rounds
})

const timerDisplay = computed(() => {
  const mins = Math.floor(timerSeconds.value / 60)
  const secs = timerSeconds.value % 60
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
})

const timerPercent = computed(() => {
  // Assume 90-second pick timer
  const totalTime = 90
  return Math.max(0, Math.min(100, (timerSeconds.value / totalTime) * 100))
})

const lotterySlots = computed(() => {
  if (!draftState.value) return []
  const order = draftState.value.draft_order
  const seen = new Set<string>()
  const names: string[] = []
  for (const uid of order) {
    if (seen.has(uid)) break
    seen.add(uid)
    const profile = profiles.value.find(p => p.id === uid)
    names.push(profile?.display_name || 'Unknown')
  }
  return names
})

let lotteryInterval: ReturnType<typeof setInterval> | null = null

function startLotteryAnimation() {
  showLottery.value = true
  lotteryComplete.value = false
  currentLotteryIndex.value = -1

  const totalSlots = lotterySlots.value.length
  let i = 0
  let audioCtx: AudioContext | null = null
  try {
    audioCtx = new AudioContext()
  } catch { /* Web Audio not available */ }

  lotteryInterval = setInterval(() => {
    currentLotteryIndex.value = i
    if (audioCtx) {
      try {
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.connect(gain)
        gain.connect(audioCtx.destination)
        osc.frequency.value = 600 + (i * 100)
        gain.gain.value = 0.1
        osc.start()
        osc.stop(audioCtx.currentTime + 0.15)
      } catch { /* ignore */ }
    }

    i++
    if (i >= totalSlots) {
      if (lotteryInterval) { clearInterval(lotteryInterval); lotteryInterval = null }
      if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null }
      lotteryComplete.value = true
      setTimeout(() => {
        showLottery.value = false
      }, 3000)
    }
  }, 2000)
}

// ─── Sound & Vibration ───

function playNotificationTone() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, ctx.currentTime)
    osc.frequency.setValueAtTime(1108, ctx.currentTime + 0.15)
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.3)

    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)

    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.5)
    osc.onended = () => ctx.close().catch(() => {})
  } catch {
    // Web Audio not available, silently ignore
  }
}

function notifyMyTurn() {
  if (!draftState.value) return
  if (lastNotifiedPickIndex === draftState.value.current_pick_index) return
  lastNotifiedPickIndex = draftState.value.current_pick_index

  navigator.vibrate?.(200)
  playNotificationTone()
}

// ─── Timer ───

function startTimer() {
  stopTimer()
  updateTimer()
  timerInterval = setInterval(updateTimer, 1000)
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
}

function updateTimer() {
  if (!draftState.value?.pick_deadline) {
    timerSeconds.value = 0
    return
  }
  const deadline = new Date(draftState.value.pick_deadline).getTime()
  const now = Date.now()
  const diff = Math.max(0, Math.floor((deadline - now) / 1000))
  timerSeconds.value = diff

  if (diff <= 0 && draftState.value.status === 'drafting') {
    handleTimerExpired()
  }
}

async function handleTimerExpired() {
  if (!tournament.value) return
  if (pickLoading.value || timerExpiredHandled.value) return
  timerExpiredHandled.value = true
  pickLoading.value = true
  try {
    await supabase.rpc('auto_pick', { p_tournament_id: tournament.value.id })
  } catch (e) {
    console.error('Auto-pick failed:', e)
  } finally {
    pickLoading.value = false
  }
}

// ─── Actions ───

function selectGolfer(golfer: Golfer) {
  if (!canPick.value) return
  selectedGolfer.value = golfer
}

async function confirmPick() {
  if (!selectedGolfer.value || !auth.user || !tournament.value || pickLoading.value) return
  pickLoading.value = true
  pickError.value = ''

  try {
    // In admin mode, pick on behalf of whoever's turn it is
    const pickUserId = adminMode.value && currentPickUserId.value
      ? currentPickUserId.value
      : auth.user.id

    const { error } = await supabase.rpc('make_draft_pick', {
      p_tournament_id: tournament.value.id,
      p_user_id: pickUserId,
      p_golfer_id: selectedGolfer.value.id,
    })
    if (error) throw error
    selectedGolfer.value = null
    searchQuery.value = ''
  } catch (err: any) {
    pickError.value = err.message ?? 'Failed to make pick'
  } finally {
    pickLoading.value = false
  }
}

function cancelSelection() {
  selectedGolfer.value = null
}

function countryFlag(country: string): string {
  const flags: Record<string, string> = {
    'USA': '\u{1F1FA}\u{1F1F8}', 'United States': '\u{1F1FA}\u{1F1F8}',
    'England': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    'Scotland': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
    'Northern Ireland': '\u{1F3F4}\u{E0067}\u{E0062}\u{E006E}\u{E0069}\u{E0072}\u{E007F}',
    'Ireland': '\u{1F1EE}\u{1F1EA}',
    'Spain': '\u{1F1EA}\u{1F1F8}',
    'Japan': '\u{1F1EF}\u{1F1F5}',
    'Australia': '\u{1F1E6}\u{1F1FA}',
    'South Korea': '\u{1F1F0}\u{1F1F7}', 'Korea': '\u{1F1F0}\u{1F1F7}',
    'Sweden': '\u{1F1F8}\u{1F1EA}',
    'Norway': '\u{1F1F3}\u{1F1F4}',
    'Canada': '\u{1F1E8}\u{1F1E6}',
    'South Africa': '\u{1F1FF}\u{1F1E6}',
    'France': '\u{1F1EB}\u{1F1F7}',
    'Germany': '\u{1F1E9}\u{1F1EA}',
    'Italy': '\u{1F1EE}\u{1F1F9}',
    'Mexico': '\u{1F1F2}\u{1F1FD}',
    'Colombia': '\u{1F1E8}\u{1F1F4}',
    'Argentina': '\u{1F1E6}\u{1F1F7}',
    'Chile': '\u{1F1E8}\u{1F1F1}',
    'China': '\u{1F1E8}\u{1F1F3}',
    'Taiwan': '\u{1F1F9}\u{1F1FC}',
    'Thailand': '\u{1F1F9}\u{1F1ED}',
    'India': '\u{1F1EE}\u{1F1F3}',
    'Belgium': '\u{1F1E7}\u{1F1EA}',
    'Denmark': '\u{1F1E9}\u{1F1F0}',
    'Austria': '\u{1F1E6}\u{1F1F9}',
    'Finland': '\u{1F1EB}\u{1F1EE}',
    'New Zealand': '\u{1F1F3}\u{1F1FF}',
    'Philippines': '\u{1F1F5}\u{1F1ED}',
    'Zimbabwe': '\u{1F1FF}\u{1F1FC}',
  }
  return flags[country] ?? '\u{1F3CC}'
}

// ─── Data Fetching ───

async function fetchData() {
  loading.value = true

  const { data: t } = await supabase
    .from('tournaments')
    .select('*')
    .eq('year', 2026)
    .single()

  tournament.value = t
  if (!t) {
    loading.value = false
    return
  }

  const [draftRes, picksRes, golfersRes, profilesRes, readyRes] = await Promise.all([
    supabase.from('draft_state').select('*').eq('tournament_id', t.id).single(),
    supabase.from('draft_picks').select('*').eq('tournament_id', t.id),
    supabase.from('golfers').select('*').eq('is_active', true),
    supabase.from('profiles').select('*'),
    supabase.from('ready_checks').select('*').eq('tournament_id', t.id),
  ])

  draftState.value = draftRes.data as unknown as DraftState | null
  draftPicks.value = picksRes.data ?? []
  golfers.value = golfersRes.data ?? []
  profiles.value = profilesRes.data ?? []
  readyChecks.value = readyRes.data ?? []

  // Build chat profile map
  for (const p of profiles.value) { chatProfileMap.value.set(p.id, p.display_name) }

  // Load scores + chat for tournament home
  if (draftState.value?.status === 'completed' || t.status === 'in-progress' || t.status === 'completed') {
    const [scoresRes, msgsRes] = await Promise.all([
      supabase.from('golfer_scores').select('*').eq('tournament_id', t.id),
      supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(50),
    ])
    golferScores.value = scoresRes.data ?? []

    const msgs = msgsRes.data ?? []
    // Fetch reactions
    const messageIds = msgs.map(m => m.id)
    let reactions: MessageReaction[] = []
    if (messageIds.length > 0) {
      const { data: reactionsData } = await supabase.from('message_reactions').select('*').in('message_id', messageIds)
      reactions = reactionsData || []
    }
    const reactionsByMsg = new Map<string, MessageReaction[]>()
    for (const r of reactions) {
      const existing = reactionsByMsg.get(r.message_id) || []
      existing.push(r)
      reactionsByMsg.set(r.message_id, existing)
    }
    chatMessages.value = msgs.map(m => {
      const msgReactions = reactionsByMsg.get(m.id) || []
      const grouped: ReactionGroup[] = []
      const rMap = new Map<string, { count: number; userIds: string[] }>()
      for (const r of msgReactions) {
        const e = rMap.get(r.emoji)
        if (e) { e.count++; e.userIds.push(r.user_id) }
        else { rMap.set(r.emoji, { count: 1, userIds: [r.user_id] }) }
      }
      rMap.forEach((v, k) => grouped.push({ emoji: k, ...v }))
      return { ...m, reactions: grouped, senderName: chatProfileMap.value.get(m.user_id) || 'Unknown' }
    }).reverse()

    chatStore.reset()
    nextTick(() => scrollChatToBottom())
  }

  // Start countdown (clear any existing interval first)
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
  updateCountdown()
  countdownInterval = setInterval(updateCountdown, 1000)

  loading.value = false
}

// ─── Realtime ───

function setupRealtimeSubscriptions() {
  if (!tournament.value) return

  const draftStateChannel = supabase
    .channel('draft-view-state')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'draft_state', filter: `tournament_id=eq.${tournament.value.id}` },
      (payload) => {
        draftState.value = payload.new as unknown as DraftState
      }
    )
    .subscribe()
  channels.push(draftStateChannel)

  const draftPicksChannel = supabase
    .channel('draft-view-picks')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'draft_picks', filter: `tournament_id=eq.${tournament.value.id}` },
      (payload) => {
        const newPick = payload.new as DraftPick
        // Avoid duplicates
        if (!draftPicks.value.find(dp => dp.id === newPick.id)) {
          draftPicks.value.push(newPick)
        }
        // Clear selection if someone else picked the golfer we had selected
        if (selectedGolfer.value && newPick.golfer_id === selectedGolfer.value.id) {
          selectedGolfer.value = null
        }
        // Trigger pick announcement
        const picker = profiles.value.find(p => p.id === newPick.user_id)
        const golfer = golfers.value.find(g => g.id === newPick.golfer_id)
        if (picker && golfer) {
          // Figure out who picks next using pick_number (1-indexed) as the next index
          let nextPlayerName: string | null = null
          if (draftState.value && draftState.value.draft_order) {
            const nextIndex = newPick.pick_number // pick_number is 1-indexed, so it equals the next index
            const nextUserId = draftState.value.draft_order[nextIndex]
            if (nextUserId) {
              const nextProfile = profiles.value.find(p => p.id === nextUserId)
              nextPlayerName = nextProfile?.display_name ?? null
            }
          }
          pickAnnouncement.value = {
            playerName: picker.display_name,
            golferName: golfer.name,
            golferImage: golfer.image_url,
            pickNumber: newPick.pick_number,
            nextPlayerName,
          }
          setTimeout(() => { pickAnnouncement.value = null }, 4000)
        }
      }
    )
    .subscribe()
  channels.push(draftPicksChannel)

  const readyChannel = supabase
    .channel('draft-view-ready')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ready_checks', filter: `tournament_id=eq.${tournament.value.id}` },
      async () => {
        if (!tournament.value) return
        const { data } = await supabase.from('ready_checks').select('*').eq('tournament_id', tournament.value.id)
        if (data) readyChecks.value = data
      }
    )
    .subscribe()
  channels.push(readyChannel)

  // Scores realtime
  const scoresChannel = supabase
    .channel('draft-view-scores')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'golfer_scores', filter: `tournament_id=eq.${tournament.value.id}` },
      async () => {
        if (!tournament.value) return
        const { data } = await supabase.from('golfer_scores').select('*').eq('tournament_id', tournament.value.id)
        golferScores.value = data ?? []
      })
    .subscribe()
  channels.push(scoresChannel)

  // Chat realtime
  const chatMsgChannel = supabase
    .channel('draft-view-chat')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => {
        const newMsg = payload.new as Message
        if (chatMessages.value.some(m => m.id === newMsg.id)) return
        chatMessages.value.push({
          ...newMsg,
          reactions: [],
          senderName: chatProfileMap.value.get(newMsg.user_id) || 'Unknown',
        })
        if (!chatUserScrolledUp.value) scrollChatToBottom()
      })
    .subscribe()
  channels.push(chatMsgChannel)

  // Tournament status realtime
  const tournamentChannel = supabase
    .channel('draft-view-tournament')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${tournament.value.id}` },
      (payload) => { tournament.value = payload.new as Tournament })
    .subscribe()
  channels.push(tournamentChannel)
}

function cleanup() {
  stopTimer()
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
  if (lotteryInterval) { clearInterval(lotteryInterval); lotteryInterval = null }
  channels.forEach(ch => supabase.removeChannel(ch))
  channels.length = 0
}

// Watch for turn changes
watch(isMyTurn, (val) => {
  if (val) {
    notifyMyTurn()
    // Scroll to top so pick interface is visible
    nextTick(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }
})

// When draft starts, show lottery and stop countdown
watch(() => draftState.value?.status, (newStatus, oldStatus) => {
  if (newStatus === 'drafting' && oldStatus !== 'drafting') {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
    startLotteryAnimation()
  }
})

// Auto-enable admin mode for proxy players, auto-disable for real players
watch(currentPickUserId, (userId) => {
  if (!userId) return
  if (proxyPlayerIds.value.has(userId)) {
    adminMode.value = true
  } else {
    adminMode.value = false
  }
})

// Watch draft state to manage timer
watch(() => draftState.value?.pick_deadline, () => {
  timerExpiredHandled.value = false
  const val = draftState.value
  if (val?.status === 'drafting' && val.pick_deadline) {
    startTimer()
  } else {
    stopTimer()
    timerSeconds.value = 0
  }
})

onMounted(async () => {
  await fetchData()
  setupRealtimeSubscriptions()
  checkCraigRoast()
  if (draftState.value?.status === 'drafting' && draftState.value.pick_deadline) {
    startTimer()
  }
  // If it's already our turn on mount, notify
  if (isMyTurn.value) {
    notifyMyTurn()
  }
})

onUnmounted(() => {
  cleanup()
})
</script>

<template>
  <div class="min-h-screen bg-golf-draft">
  <div class="p-4 sm:p-6 lg:p-8 mx-auto space-y-4 pb-24" :class="draftState?.status === 'drafting' && !showLottery ? 'max-w-lg md:max-w-3xl lg:max-w-6xl' : draftState?.status === 'completed' ? 'max-w-lg md:max-w-3xl lg:max-w-4xl' : 'max-w-lg md:max-w-2xl lg:max-w-3xl'">
    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-augusta border-t-transparent"></div>
    </div>

    <!-- ==================== WAITING / PRE-DRAFT ==================== -->
    <template v-else-if="!draftState || draftState.status === 'waiting'">
      <!-- Header -->
      <div class="bg-augusta-gradient rounded-2xl p-6 shadow-lg text-center">
        <img src="/masters-logo.png" alt="The Masters" class="h-12 sm:h-16 mx-auto mb-2" />
        <h1 class="text-2xl font-bold text-gold-glow tracking-wider">THE MORRISON OPEN</h1>
        <p class="text-cream/80 mt-1 text-sm">Draft Night &middot; Monday, April 6 &middot; 6:00 PM MST</p>

        <!-- Countdown -->
        <div class="flex justify-center gap-2 sm:gap-4 mt-4">
          <div v-for="(val, label) in { Days: countdown.days, Hrs: countdown.hours, Min: countdown.minutes, Sec: countdown.seconds }" :key="label" class="text-center">
            <div class="bg-white/15 rounded-lg px-3 py-2 sm:px-5 sm:py-3 md:px-6 md:py-4 min-w-[56px] sm:min-w-[72px] md:min-w-[80px]">
              <span class="text-2xl sm:text-3xl md:text-4xl font-bold font-score text-white">{{ String(val).padStart(2, '0') }}</span>
            </div>
            <span class="text-cream/50 text-[10px] sm:text-xs mt-1 block uppercase">{{ label }}</span>
          </div>
        </div>

        <!-- Google Meet -->
        <a
          :href="MEET_LINK"
          target="_blank"
          class="mt-4 inline-flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white text-sm sm:text-base font-semibold px-5 py-2.5 sm:px-6 sm:py-3 rounded-xl transition-colors shadow-md min-h-[44px]"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l5-3v10l-5-3"/><rect x="2" y="6" width="13" height="12" rx="2"/></svg>
          Join Google Meet
        </a>
      </div>

      <!-- Players & Ready Status -->
      <div class="bg-white rounded-2xl shadow-md p-5">
        <h2 class="font-bold text-dark text-lg mb-3">Players</h2>
        <div class="space-y-2">
          <button
            v-for="profile in profiles"
            :key="profile.id"
            @click="profile.id === auth.user?.id ? toggleReady() : toggleReadyFor(profile.id)"
            class="w-full flex items-center justify-between py-2.5 px-3 rounded-lg cursor-pointer transition-colors min-h-[44px]"
            :class="isPlayerReady(profile.id) ? 'bg-green-50 hover:bg-green-100' : 'bg-gray-50 hover:bg-gray-100'"
          >
            <span class="font-medium text-dark">{{ profile.display_name }}</span>
            <span v-if="isPlayerReady(profile.id)" class="text-green-500 font-bold text-sm">Ready</span>
            <span v-else class="text-gray-400 text-sm">Tap to ready</span>
          </button>
        </div>

        <div v-if="notReadyPlayers.length > 0" class="mt-3 text-sm text-dark/50">
          Waiting for: {{ notReadyPlayers.map(p => p.display_name).join(', ') }}
        </div>
        <div v-else class="mt-3 text-sm text-green-600 font-medium">
          All players ready!
        </div>
      </div>

      <!-- Add Player -->
      <div class="bg-white rounded-2xl shadow-md p-5">
        <h3 class="font-bold text-dark text-sm mb-1">Add a Player</h3>
        <p class="text-dark/40 text-xs mb-3">Drafting on someone's behalf? Add them here.</p>
        <div class="flex gap-2">
          <input
            v-model="proxyName"
            type="text"
            placeholder="Their name"
            class="flex-1 px-3 py-2 rounded-lg border border-dark/15 text-sm min-h-[44px] focus:outline-none focus:ring-2 focus:ring-augusta/30"
            @keyup.enter="addProxyPlayer"
          />
          <button
            @click="addProxyPlayer"
            :disabled="!proxyName.trim() || addingProxy"
            class="bg-augusta text-white px-4 py-2 rounded-lg text-sm font-semibold min-h-[44px] disabled:opacity-50 cursor-pointer"
          >
            {{ addingProxy ? '...' : 'Add' }}
          </button>
        </div>
      </div>

      <!-- Ready Toggle (for yourself) -->
      <button
        @click="toggleReady"
        :disabled="togglingReady"
        class="w-full py-3.5 min-h-[48px] rounded-xl font-bold text-white text-lg transition-all active:scale-95"
        :class="currentUserReady ? 'bg-gold shadow-md shadow-gold/30 text-dark' : 'bg-augusta shadow-md shadow-augusta/30'"
      >
        <span v-if="togglingReady" class="animate-pulse">Updating...</span>
        <span v-else>{{ currentUserReady ? "I'm Ready!" : "I'm Ready" }}</span>
      </button>

      <!-- Start Draft Button -->
      <button
        v-if="allReady && profiles.length >= 1"
        @click="startDraft"
        :disabled="startingDraft"
        class="w-full py-4 min-h-[52px] rounded-xl font-bold text-white text-xl bg-augusta-gradient shadow-lg active:scale-95 transition-all"
      >
        <span v-if="startingDraft" class="animate-pulse">Starting Draft...</span>
        <span v-else>Start the Draft!</span>
      </button>

      <!-- Browse Field Link -->
      <router-link
        to="/golfers"
        class="block w-full py-3 rounded-xl font-semibold text-augusta text-center border-2 border-augusta/20 hover:bg-augusta/5 transition-colors"
      >
        Browse the Field &rarr;
      </router-link>
    </template>

    <!-- ==================== LOTTERY ==================== -->
    <template v-else-if="draftState?.status === 'drafting' && showLottery">
      <div class="text-center space-y-6">
        <div class="bg-augusta-gradient rounded-2xl p-6 sm:p-8 shadow-lg">
          <img src="/masters-logo.png" alt="The Masters" class="h-14 sm:h-16 mx-auto mb-3" />
          <h1 class="text-2xl sm:text-3xl font-bold text-gold-glow tracking-wider">DRAFT ORDER</h1>
          <p class="text-cream/70 text-sm mt-1">Drawing names...</p>
        </div>

        <div class="space-y-3">
          <div
            v-for="(slot, index) in lotterySlots"
            :key="index"
            class="bg-white rounded-xl shadow-md p-4 sm:p-5 flex items-center gap-4 transition-all duration-500"
            :class="index <= currentLotteryIndex ? 'scale-100 opacity-100' : 'scale-95 opacity-50'"
          >
            <div
              class="w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center font-bold font-score text-xl sm:text-2xl shrink-0"
              :class="index <= currentLotteryIndex ? 'bg-gold text-dark' : 'bg-gray-200 text-gray-400'"
            >
              {{ index + 1 }}
            </div>
            <div class="flex-1 text-left">
              <p class="text-xs text-dark/40 uppercase tracking-wider">
                {{ index === 0 ? '1st Pick' : index === 1 ? '2nd Pick' : index === 2 ? '3rd Pick' : `${index + 1}th Pick` }}
              </p>
              <p
                class="text-xl sm:text-2xl font-bold transition-all duration-300"
                :class="index <= currentLotteryIndex ? 'text-dark' : 'text-gray-300'"
              >
                {{ index <= currentLotteryIndex ? slot : '???' }}
              </p>
            </div>
            <span v-if="index <= currentLotteryIndex" class="text-2xl animate-bounce">🏌️</span>
          </div>
        </div>

        <p v-if="lotteryComplete" class="text-dark/50 text-sm animate-pulse mt-2">Starting draft...</p>
      </div>
    </template>

    <!-- ==================== DRAFTING ==================== -->
    <template v-else-if="draftState?.status === 'drafting' && !showLottery">
      <!-- Pick Announcement Overlay -->
      <Transition
        enter-active-class="transition-all duration-500 ease-out"
        enter-from-class="opacity-0 scale-90"
        enter-to-class="opacity-100 scale-100"
        leave-active-class="transition-all duration-300 ease-in"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-90"
      >
        <div v-if="pickAnnouncement" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" @click="pickAnnouncement = null">
          <div class="bg-white rounded-3xl shadow-2xl p-8 max-w-sm w-full text-center">
            <p class="text-dark/50 text-sm uppercase tracking-wider font-medium">Pick #{{ pickAnnouncement.pickNumber }}</p>
            <p class="text-augusta font-bold text-lg mt-1">{{ pickAnnouncement.playerName }} selects</p>
            <img v-if="pickAnnouncement.golferImage" :src="pickAnnouncement.golferImage" class="w-24 h-24 rounded-full mx-auto my-4 object-cover shadow-lg" />
            <p class="text-3xl font-bold text-dark">{{ pickAnnouncement.golferName }}</p>
            <div v-if="pickAnnouncement.nextPlayerName" class="mt-4 pt-4 border-t border-dark/10">
              <p class="text-dark/40 text-xs uppercase tracking-wider">Up Next</p>
              <p class="text-augusta font-bold text-lg flex items-center justify-center gap-2">
                <span class="animate-pulse">&#9200;</span>
                {{ pickAnnouncement.nextPlayerName }}
              </p>
            </div>
          </div>
        </div>
      </Transition>

      <!-- Draft Header -->
      <div class="bg-augusta-gradient rounded-2xl p-4 sm:p-6 shadow-lg text-center">
        <img src="/masters-logo.png" alt="The Masters" class="h-12 sm:h-16 mx-auto mb-2" />
        <h1 class="text-xl sm:text-2xl font-bold text-gold-glow tracking-wider">THE MORRISON OPEN DRAFT</h1>
        <p class="text-cream/70 text-sm mt-1">
          Round {{ currentRound }} of {{ totalRounds }}
          &middot; Pick {{ (draftState?.current_pick_index ?? 0) + 1 }} of {{ totalPicks }}
        </p>
        <a
          :href="MEET_LINK"
          target="_blank"
          class="mt-3 inline-flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white text-sm sm:text-base font-semibold px-5 py-2.5 rounded-xl transition-colors shadow-md min-h-[44px]"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 10l5-3v10l-5-3"/><rect x="2" y="6" width="13" height="12" rx="2"/></svg>
          Join Google Meet
        </a>
        <label class="flex items-center justify-center gap-2 text-cream/70 text-xs mt-3 cursor-pointer">
          <input type="checkbox" v-model="adminMode" class="rounded" />
          Draft Admin (pick for others)
        </label>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Left: Timer + AI + Pick UI -->
        <div class="space-y-4">
          <!-- Timer Section -->
          <div
            class="rounded-2xl p-5 shadow-md text-center"
            :class="canPick ? 'bg-green-50 border-2 border-green-400' : 'bg-white'"
          >
            <!-- Whose turn -->
            <p v-if="isMyTurn" class="text-green-600 font-bold text-lg uppercase tracking-wide animate-pulse">
              YOUR PICK!
            </p>
            <p v-else-if="adminMode" class="text-green-600 font-bold text-lg uppercase tracking-wide">
              PICKING FOR {{ currentPickUser?.display_name?.toUpperCase() ?? 'UNKNOWN' }}
            </p>
            <div v-else class="mt-2">
              <p class="text-dark/40 text-xs uppercase tracking-wider">On the Clock</p>
              <p class="text-dark font-bold text-xl flex items-center justify-center gap-2">
                <span class="animate-pulse">⏰</span>
                {{ currentPickUser?.display_name ?? 'Unknown' }}
              </p>
            </div>

            <!-- Timer display -->
            <div class="mt-3">
              <span
                class="text-5xl font-bold font-score"
                :class="timerSeconds <= 10 ? 'text-red-600 animate-pulse' : canPick ? 'text-green-700' : 'text-dark'"
              >
                {{ timerDisplay }}
              </span>
            </div>

            <!-- Timer bar -->
            <div class="mt-4 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                class="h-full rounded-full transition-all duration-1000 ease-linear"
                :class="timerPercent <= 20 ? 'bg-red-500' : timerPercent <= 50 ? 'bg-yellow-500' : 'bg-green-500'"
                :style="{ width: timerPercent + '%' }"
              ></div>
            </div>
          </div>

          <!-- Pick Interface -->
          <div class="bg-white rounded-2xl shadow-md overflow-hidden">
            <!-- Selected golfer confirmation -->
            <div v-if="selectedGolfer && canPick" class="p-4 bg-gold/10 border-b border-gold/30">
              <p class="text-sm text-gray-500 mb-2">Confirm your pick:</p>
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <span class="text-2xl">{{ countryFlag(selectedGolfer.country) }}</span>
                  <div>
                    <p class="font-bold text-dark text-lg">{{ selectedGolfer.name }}</p>
                    <p class="text-gray-400 text-xs">
                      #{{ selectedGolfer.world_ranking }} &middot; {{ selectedGolfer.odds ?? '--' }}
                    </p>
                  </div>
                </div>
                <button
                  @click="cancelSelection"
                  class="text-gray-400 hover:text-gray-600 text-xl px-2"
                  :disabled="pickLoading"
                >
                  &#10005;
                </button>
              </div>
              <button
                @click="confirmPick"
                :disabled="pickLoading"
                class="w-full mt-3 py-3 rounded-xl font-bold text-white text-lg bg-augusta-gradient shadow-md active:scale-95 transition-transform disabled:opacity-50"
              >
                <span v-if="pickLoading" class="animate-pulse">Picking...</span>
                <span v-else>Confirm Pick: {{ selectedGolfer.name }}</span>
              </button>
              <p v-if="pickError" class="text-red-500 text-sm mt-2 text-center">{{ pickError }}</p>
            </div>

            <!-- Header + Search + Sort -->
            <div class="p-4 border-b border-gray-100">
              <div class="flex items-center justify-between mb-3">
                <h2 class="font-bold text-dark text-lg">
                  {{ canPick ? 'Select a Golfer' : 'Available Golfers' }}
                </h2>
                <span class="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">
                  {{ availableGolfers.length }} left
                </span>
              </div>
              <!-- Sort toggle -->
              <div class="flex gap-2 mb-3">
                <button
                  @click="golferSortBy = 'ranking'"
                  class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                  :class="golferSortBy === 'ranking' ? 'bg-augusta text-white' : 'bg-gray-100 text-dark/60 hover:bg-gray-200'"
                >
                  Power Ranking
                </button>
                <button
                  @click="golferSortBy = 'name'"
                  class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
                  :class="golferSortBy === 'name' ? 'bg-augusta text-white' : 'bg-gray-100 text-dark/60 hover:bg-gray-200'"
                >
                  A-Z (Last Name)
                </button>
              </div>
              <div class="relative">
                <input
                  v-model="searchQuery"
                  type="text"
                  placeholder="Search golfers..."
                  class="w-full pl-9 pr-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-dark text-sm focus:outline-none focus:ring-2 focus:ring-augusta/30 focus:border-augusta"
                />
                <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                </svg>
              </div>
              <p v-if="!canPick" class="text-gray-400 text-xs mt-2 italic">
                Waiting for {{ currentPickUser?.display_name ?? 'Unknown' }} to pick...
              </p>
            </div>

            <!-- Golfer list -->
            <div class="max-h-80 sm:max-h-96 overflow-y-auto overscroll-contain divide-y divide-gray-50">
              <div v-if="sortedAvailableGolfers.length === 0" class="p-6 text-center text-gray-400 text-sm">
                No golfers match your search.
              </div>
              <button
                v-for="golfer in sortedAvailableGolfers"
                :key="golfer.id"
                @click="selectGolfer(golfer)"
                :disabled="!canPick || pickLoading"
                class="w-full flex items-center gap-3 px-4 py-3 min-h-[48px] text-left transition-colors"
                :class="[
                  canPick ? 'hover:bg-augusta/5 active:bg-augusta/10 cursor-pointer' : 'cursor-default',
                  selectedGolfer?.id === golfer.id ? 'bg-gold/10' : '',
                ]"
              >
                <img
                  v-if="golfer.image_url"
                  :src="golfer.image_url"
                  :alt="golfer.name"
                  class="w-10 h-10 sm:w-12 sm:h-12 rounded-full object-cover bg-cream flex-shrink-0"
                />
                <span v-else class="text-lg flex-shrink-0 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-augusta/10 flex items-center justify-center">{{ countryFlag(golfer.country) }}</span>
                <div class="flex-1 min-w-0">
                  <p class="font-medium text-dark text-sm sm:text-base truncate">{{ golfer.name }}</p>
                  <p class="text-gray-400 text-xs">{{ countryFlag(golfer.country) }} {{ golfer.country }}</p>
                </div>
                <div class="text-right flex-shrink-0">
                  <p class="text-xs font-bold text-dark">#{{ golfer.world_ranking }}</p>
                  <p class="text-xs text-gray-400">{{ golfer.odds ?? '--' }}</p>
                </div>
              </button>
            </div>
          </div>
        </div>

        <!-- Right: Draft Board + Your Team -->
        <div class="space-y-4">
          <!-- Draft Board -->
          <div class="bg-white rounded-2xl shadow-md p-4">
            <h2 class="font-bold text-dark text-lg mb-3">Draft Board</h2>
            <div class="space-y-4">
              <div v-for="round in draftBoard" :key="round.round">
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-xs font-bold text-augusta uppercase tracking-wide">Round {{ round.round }}</span>
                  <span v-if="round.reversed" class="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                    &#8635; Snake
                  </span>
                  <div class="flex-1 border-t border-gray-100"></div>
                </div>
                <div class="space-y-1.5">
                  <div
                    v-for="slot in round.slots"
                    :key="slot.pickNumber"
                    class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all"
                    :class="[
                      slot.isCurrent ? 'bg-green-50 border border-green-300 animate-pulse' : '',
                      slot.isPicked ? 'bg-gray-50' : '',
                      !slot.isPicked && !slot.isCurrent ? 'bg-gray-50/50' : '',
                    ]"
                  >
                    <span class="w-6 text-center text-xs font-bold font-score text-gray-400">
                      {{ slot.pickNumber }}
                    </span>
                    <span class="w-20 sm:w-28 md:w-32 truncate font-medium text-sm" :class="slot.isCurrent ? 'text-green-700' : 'text-dark'">
                      {{ slot.userName }}
                    </span>
                    <span class="flex-1 text-right truncate" :class="slot.isPicked ? 'text-dark font-medium' : 'text-gray-300'">
                      {{ slot.golfer ? slot.golfer.name : (slot.isCurrent ? '...' : '--') }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Your Team Summary -->
          <div class="bg-white rounded-2xl shadow-md p-4">
            <h2 class="font-bold text-dark text-lg mb-3">Your Team</h2>
            <div v-if="myPicks.length === 0" class="text-gray-400 text-sm text-center py-4">
              No picks yet
            </div>
            <div v-else class="space-y-2">
              <div
                v-for="(pick, idx) in myPicks"
                :key="pick.id"
                class="flex items-center gap-3 px-3 py-2 bg-augusta/5 rounded-xl"
              >
                <span class="text-sm font-bold font-score text-augusta w-6 text-center">{{ idx + 1 }}</span>
                <span class="text-lg">{{ pick.golfer ? countryFlag(pick.golfer.country) : '' }}</span>
                <span class="font-medium text-dark text-sm">{{ pick.golfer?.name ?? 'Unknown' }}</span>
                <span class="ml-auto text-xs text-gray-400">#{{ pick.golfer?.world_ranking ?? '--' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== TOURNAMENT HOME (COMPLETED DRAFT) ==================== -->
    <template v-else-if="draftState?.status === 'completed'">

      <!-- Craig Roast Modal -->
      <Teleport to="body">
        <Transition name="fade">
          <div v-if="showCraigRoast" class="fixed inset-0 z-[100] flex items-center justify-center p-4" @click.self="dismissCraigRoast">
            <div class="fixed inset-0 bg-black/60 backdrop-blur-sm"></div>
            <div class="relative bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-bounce-in">
              <!-- Header -->
              <div class="bg-augusta-gradient px-6 py-4 text-center">
                <p class="text-gold-glow text-xs font-bold uppercase tracking-widest">Morrison Open Handicap Bureau</p>
                <h2 class="text-white text-xl font-bold mt-1">Official Ruling</h2>
              </div>
              <!-- Scorecard -->
              <div class="px-6 py-4">
                <div class="bg-gray-100 rounded-xl p-4 mb-4">
                  <div class="flex items-center justify-between mb-2">
                    <div>
                      <p class="text-dark font-bold text-sm">Moses Pointe GR (18)</p>
                      <p class="text-gray-400 text-xs">Apr 8, 2026 &middot; Red Tees &middot; 5,786 yds</p>
                    </div>
                    <div class="text-right">
                      <p class="text-3xl font-bold font-score text-red-600">112</p>
                      <p class="text-xs text-red-500 font-bold">+40</p>
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-2 text-center text-xs mt-2">
                    <div class="bg-white rounded-lg py-1.5">
                      <p class="text-gray-400">Front 9</p>
                      <p class="font-bold font-score text-dark">56 <span class="text-red-500 text-[10px]">+20</span></p>
                    </div>
                    <div class="bg-white rounded-lg py-1.5">
                      <p class="text-gray-400">Back 9</p>
                      <p class="font-bold font-score text-dark">56 <span class="text-red-500 text-[10px]">+20</span></p>
                    </div>
                  </div>
                </div>
                <!-- The roast -->
                <p class="text-dark text-sm leading-relaxed">
                  After carefully calculating Craig's handicap from his last 18, the Morrison Open Handicap Bureau has determined that his official handicap from the golds is <span class="font-bold text-augusta">autism</span>.
                </p>
                <p class="text-dark text-sm leading-relaxed mt-3">
                  Catch Craig on the new season of <span class="font-bold italic">Love on the Spectrum</span>. Premiering this fall.
                </p>
              </div>
              <!-- Dismiss -->
              <div class="px-6 pb-5">
                <button
                  @click="dismissCraigRoast"
                  class="w-full py-3 rounded-xl font-bold text-white bg-augusta-gradient shadow-lg active:scale-95 transition-all"
                >
                  I've Seen Enough
                </button>
              </div>
            </div>
          </div>
        </Transition>
      </Teleport>

      <!-- Header -->
      <div class="bg-augusta-gradient rounded-2xl p-5 shadow-lg text-center">
        <img src="/masters-logo.png" alt="The Masters" class="h-10 mx-auto mb-1" />
        <h1 class="text-xl font-bold text-gold-glow tracking-wider">THE MORRISON OPEN</h1>
        <p v-if="tournament?.current_round" class="text-cream/70 text-xs mt-1">
          The Masters &ndash; Round {{ tournament.current_round }}
        </p>
        <p v-else class="text-cream/70 text-xs mt-1">Tournament starts April 9</p>
      </div>

      <!-- Podium -->
      <div class="bg-white rounded-2xl shadow-md p-4">
        <div class="flex items-end justify-center gap-3 pt-4 pb-2">
          <!-- 2nd Place -->
          <div v-if="playerStandings[1]" class="flex flex-col items-center w-24">
            <p class="text-sm font-semibold text-dark truncate w-full text-center">{{ playerStandings[1].name }}</p>
            <p class="font-bold font-score text-sm" :class="(playerStandings[1].totalToPar ?? 0) < 0 ? 'text-red-600' : 'text-gray-600'">
              {{ formatToPar(playerStandings[1].totalToPar) }}
            </p>
            <div class="w-full bg-gray-300 rounded-t-lg mt-2 flex items-end justify-center" style="height: 72px">
              <span class="text-2xl font-bold font-score text-white pb-2">2</span>
            </div>
          </div>
          <!-- 1st Place -->
          <div v-if="playerStandings[0]" class="flex flex-col items-center w-28">
            <p class="text-sm font-bold text-dark truncate w-full text-center">{{ playerStandings[0].name }}</p>
            <p class="font-bold font-score text-base" :class="(playerStandings[0].totalToPar ?? 0) < 0 ? 'text-red-600' : 'text-gray-600'">
              {{ formatToPar(playerStandings[0].totalToPar) }}
            </p>
            <div class="w-full bg-gold rounded-t-lg mt-2 flex items-end justify-center" style="height: 96px">
              <span class="text-3xl font-bold font-score text-white pb-2">1</span>
            </div>
          </div>
          <!-- 3rd Place -->
          <div v-if="playerStandings[2]" class="flex flex-col items-center w-24">
            <p class="text-sm font-semibold text-dark truncate w-full text-center">{{ playerStandings[2].name }}</p>
            <p class="font-bold font-score text-sm" :class="(playerStandings[2].totalToPar ?? 0) < 0 ? 'text-red-600' : 'text-gray-600'">
              {{ formatToPar(playerStandings[2].totalToPar) }}
            </p>
            <div class="w-full bg-amber-600 rounded-t-lg mt-2 flex items-end justify-center" style="height: 56px">
              <span class="text-2xl font-bold font-score text-white pb-2">3</span>
            </div>
          </div>
        </div>
        <router-link to="/leaderboard" class="block text-center text-augusta font-semibold text-xs mt-3 hover:underline">
          See All Standings &rarr;
        </router-link>
      </div>

      <!-- Side by Side: My Team + Chat -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- My Team -->
        <div class="bg-white rounded-2xl shadow-md p-4 flex flex-col">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-bold text-dark text-base">Your Team</h2>
            <router-link to="/my-team" class="text-xs text-augusta font-semibold hover:underline">Details &rarr;</router-link>
          </div>
          <div class="space-y-1.5 flex-1">
            <div
              v-for="(pick, idx) in myTeamWithScores"
              :key="pick.id"
              class="flex items-center justify-between py-2 px-3 rounded-xl"
              :class="idx < 2 ? 'bg-gold/8' : 'bg-gray-50'"
            >
              <div class="flex items-center gap-2 min-w-0">
                <span v-if="idx < 2" class="text-[9px] font-bold text-gold bg-gold/15 px-1.5 py-0.5 rounded uppercase flex-shrink-0">CT</span>
                <span v-else class="w-6 flex-shrink-0"></span>
                <div class="min-w-0">
                  <p class="font-medium text-dark text-sm truncate">{{ pick.golfer?.name ?? 'Unknown' }}</p>
                  <p class="text-[10px] text-gray-400">
                    {{ pick.score?.position ?? '--' }}
                    <span v-if="pick.score?.thru"> &middot; Thru {{ pick.score.thru }}</span>
                  </p>
                </div>
              </div>
              <span class="font-bold font-score text-sm flex-shrink-0 ml-2" :class="(pick.score?.to_par ?? 0) < 0 ? 'text-red-600' : 'text-gray-600'">
                {{ pick.score?.to_par != null ? formatToPar(pick.score.to_par) : '--' }}
              </span>
            </div>
          </div>
          <!-- Quick Links -->
          <div class="flex gap-2 mt-3 pt-3 border-t border-gray-100">
            <router-link to="/leaderboard" class="flex-1 text-center bg-gray-50 rounded-lg py-2 text-xs font-semibold text-dark hover:bg-gray-100 transition-colors">
              Leaderboard
            </router-link>
            <router-link to="/matchup" class="flex-1 text-center bg-gray-50 rounded-lg py-2 text-xs font-semibold text-dark hover:bg-gray-100 transition-colors">
              Head to Head
            </router-link>
            <router-link to="/golfers" class="flex-1 text-center bg-gray-50 rounded-lg py-2 text-xs font-semibold text-dark hover:bg-gray-100 transition-colors">
              Full Field
            </router-link>
          </div>
        </div>

        <!-- Chat -->
        <div class="bg-white rounded-2xl shadow-md overflow-hidden flex flex-col">
          <div class="bg-augusta px-4 py-2.5 flex items-center justify-between flex-shrink-0">
            <h2 class="text-white font-bold text-sm tracking-tight">Chat</h2>
            <router-link to="/chat" class="text-white/60 text-xs hover:text-white">Full Chat &rarr;</router-link>
          </div>
          <div
            ref="chatFeedRef"
            class="flex-1 overflow-y-auto px-3 py-2 space-y-2 bg-cream/30"
            style="min-height: 280px; max-height: 400px"
            @scroll="handleChatScroll"
          >
            <div
              v-for="msg in chatMessages"
              :key="msg.id"
              class="flex flex-col"
              :class="msg.user_id === auth.user?.id ? 'items-end' : 'items-start'"
            >
              <span class="text-[10px] font-bold mb-0.5 px-1" :class="msg.user_id === auth.user?.id ? 'text-augusta-dark' : 'text-dark/50'">
                {{ msg.senderName }}
              </span>
              <div class="max-w-[85%]">
                <div
                  class="px-3 py-1.5 rounded-2xl text-sm leading-relaxed break-words"
                  :class="msg.user_id === auth.user?.id
                    ? 'bg-augusta text-white rounded-br-md'
                    : 'bg-white text-dark rounded-bl-md shadow-sm'"
                  v-html="chatRenderContent(msg.content)"
                />
                <div v-if="msg.reactions.length > 0" class="flex flex-wrap gap-0.5 mt-0.5" :class="msg.user_id === auth.user?.id ? 'justify-end' : 'justify-start'">
                  <span v-for="reaction in msg.reactions" :key="reaction.emoji" class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full text-[10px] bg-white border border-gray-100">
                    <span>{{ reaction.emoji }}</span><span class="font-medium text-dark/60">{{ reaction.count }}</span>
                  </span>
                </div>
              </div>
              <span class="text-[9px] text-dark/30 mt-0.5 px-1">{{ chatFormatTimestamp(msg.created_at) }}</span>
            </div>
            <div v-if="chatMessages.length === 0" class="text-center py-8 text-gray-400 text-sm">No messages yet</div>
          </div>
          <div class="border-t border-gray-100 px-3 py-2 flex items-end gap-2 flex-shrink-0">
            <textarea
              ref="chatInputRef"
              v-model="newChatMessage"
              placeholder="Send a message..."
              rows="1"
              class="flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm min-h-[38px] focus:outline-none focus:border-augusta focus:ring-1 focus:ring-augusta/30 bg-cream/30 placeholder-dark/30"
              style="max-height: 72px"
              @keydown="handleChatKeydown"
              @input="handleChatInput"
            />
            <button
              class="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all"
              :class="newChatMessage.trim() ? 'bg-gold text-white shadow-sm' : 'bg-gray-200 text-gray-400 cursor-not-allowed'"
              :disabled="!newChatMessage.trim()"
              @click="sendChatMessage"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
@keyframes bounce-in {
  0% { transform: scale(0.8) translateY(20px); opacity: 0; }
  50% { transform: scale(1.03); }
  100% { transform: scale(1) translateY(0); opacity: 1; }
}
.animate-bounce-in { animation: bounce-in 0.4s ease-out; }
</style>
