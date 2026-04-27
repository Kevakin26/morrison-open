<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import type {
  WeeklyEventRow as WeeklyEvent,
  SeasonStandingRow as Standing,
  WeeklyResultRow as Result,
  PickRow as Pick,
  LeaderboardSnapshotRow as Snapshot,
  ProfileRow as Profile,
} from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

const router = useRouter()

const activeEvent = ref<WeeklyEvent | null>(null)
const upcomingEvent = ref<WeeklyEvent | null>(null)
const standings = ref<Standing[]>([])
const weekPicks = ref<Pick[]>([])
const weekResults = ref<Result[]>([])
const weekSnapshots = ref<Record<string, Snapshot>>({})
const members = ref<Profile[]>([])
const loading = ref(true)

let channels: RealtimeChannel[] = []

const nameById = computed(() => {
  const m = new Map<string, string>()
  for (const p of members.value) m.set(p.id, (p.display_name ?? '').trim() || 'Unknown')
  return m
})

const statusLabel = (s: string) => ({ active: '', cut: 'CUT', wd: 'WD', dq: 'DQ' } as Record<string, string>)[s] || ''

type PickRow = {
  user_id: string
  golfer_name: string
  position_display: string | null
  position_numeric: number | null
  total_to_par_display: string | null
  status: string
  points: number
  rank_in_league: number | null
}

const weekPickRows = computed<PickRow[]>(() => {
  if (weekResults.value.length === weekPicks.value.length && weekResults.value.length > 0) {
    return [...weekResults.value]
      .sort((a, b) => a.rank_in_league - b.rank_in_league)
      .map(r => ({
        user_id: r.user_id,
        golfer_name: r.golfer_name,
        position_display: r.position_display,
        position_numeric: r.position_numeric,
        total_to_par_display: r.total_to_par_display,
        status: r.status,
        points: r.points,
        rank_in_league: r.rank_in_league,
      }))
  }
  return weekPicks.value.map(p => {
    const snap = weekSnapshots.value[p.golfer_espn_id]
    return {
      user_id: p.user_id,
      golfer_name: p.golfer_name,
      position_display: snap?.position_display ?? null,
      position_numeric: snap?.position_numeric ?? null,
      total_to_par_display: snap?.total_to_par_display ?? null,
      status: snap?.status ?? 'active',
      points: 0,
      rank_in_league: null,
    }
  }).sort((a, b) => (a.position_numeric ?? 9999) - (b.position_numeric ?? 9999))
})

async function load() {
  loading.value = true

  const [{ data: events }, { data: s }, { data: season }] = await Promise.all([
    supabase.from('weekly_events').select('*').order('start_date', { ascending: true }).limit(20),
    supabase.from('season_standings').select('*'),
    supabase.from('seasons').select('id').eq('status', 'active').single(),
  ])

  activeEvent.value = (events ?? []).find(e => ['drafting', 'in_progress'].includes(e.status)) ?? null
  upcomingEvent.value = (events ?? []).find(e => e.status === 'upcoming') ?? null
  standings.value = (s ?? []) as Standing[]

  if (season) {
    const { data: lm } = await supabase
      .from('league_members')
      .select('profiles:profiles!inner(id,display_name,created_at)')
      .eq('season_id', (season as any).id)
    members.value = (lm ?? []).map((r: any) => r.profiles).filter(Boolean) as Profile[]
  }

  if (activeEvent.value) {
    const evId = activeEvent.value.id
    const [{ data: picks }, { data: results }, { data: snaps }] = await Promise.all([
      supabase.from('picks').select('*').eq('event_id', evId),
      supabase.from('weekly_results').select('*').eq('event_id', evId),
      supabase.from('leaderboard_snapshots').select('*').eq('event_id', evId),
    ])
    weekPicks.value = (picks ?? []) as Pick[]
    weekResults.value = (results ?? []) as Result[]
    const m: Record<string, Snapshot> = {}
    for (const snap of (snaps ?? []) as Snapshot[]) m[snap.golfer_espn_id] = snap
    weekSnapshots.value = m
  } else {
    weekPicks.value = []; weekResults.value = []; weekSnapshots.value = {}
  }

  loading.value = false
}

const countdown = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const teeOffTarget = computed(() => {
  // Use the next event the league cares about: prefer one that hasn't teed
  // off yet (drafting/upcoming) over an in_progress one.
  const next = (activeEvent.value && activeEvent.value.status === 'drafting')
    ? activeEvent.value
    : upcomingEvent.value
  if (!next) return null
  // start_date is a date string; the PGA Thursday morning round typically
  // tees off ~7am ET (11:00 UTC).
  return new Date(next.start_date + 'T11:00:00Z')
})

function tick() {
  if (!teeOffTarget.value) { countdown.value = ''; return }
  const diff = teeOffTarget.value.getTime() - Date.now()
  if (diff <= 0) { countdown.value = 'Tee off has begun'; return }
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff / 3600000) % 24)
  const m = Math.floor((diff / 60000) % 60)
  const s = Math.floor((diff / 1000) % 60)
  countdown.value = `${d}d ${h}h ${m}m ${s}s`
}

onMounted(() => {
  load()
  tick()
  timer = setInterval(tick, 1000)
  channels.push(
    supabase.channel('home')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_events' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_results' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picks' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leaderboard_snapshots' }, load)
      .subscribe()
  )
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  channels.forEach(c => supabase.removeChannel(c))
  channels = []
})
</script>

<template>
  <div class="relative min-h-screen">
    <!-- Background video -->
    <video
      class="fixed inset-0 w-full h-full object-cover z-0"
      autoplay
      muted
      loop
      playsinline
      preload="auto"
      aria-hidden="true"
    >
      <source src="/videos/hero.mp4" type="video/mp4" />
    </video>
    <!-- Dark overlay so content stays readable -->
    <div class="fixed inset-0 bg-gradient-to-b from-augusta-dark/70 via-dark/60 to-dark/80 z-0"></div>

    <div class="max-w-3xl mx-auto p-4 space-y-4 relative z-10">
    <div v-if="loading" class="text-center text-cream/80 py-12">Loading…</div>

    <template v-else>
      <!-- Hero -->
      <div class="bg-black/30 backdrop-blur-md text-white rounded-xl p-5 shadow-lg border border-white/10">
        <p class="text-xs uppercase tracking-widest text-gold">Morrison Open · 2026 Season</p>
        <h1 class="text-3xl font-bold mt-1 text-gold-glow">Every week. One pick. One winner.</h1>
        <p class="text-cream/80 text-sm mt-2">
          Each week, every player drafts a single PGA golfer. Low cumulative points wins the season.
        </p>
      </div>

      <!-- Active event card -->
      <div v-if="activeEvent" class="bg-white/90 backdrop-blur-md rounded-xl p-4 shadow border border-white/30">
        <p class="text-xs uppercase tracking-widest text-gray-500">This Week</p>
        <h2 class="text-xl font-bold text-dark">{{ activeEvent.name }}</h2>
        <p class="text-sm text-gray-500">{{ activeEvent.start_date }} → {{ activeEvent.end_date }}</p>
        <div v-if="activeEvent.status === 'drafting' && countdown" class="mt-3">
          <p class="text-[10px] uppercase tracking-widest text-gray-500">Tee off in</p>
          <p class="font-score text-2xl text-augusta">{{ countdown }}</p>
        </div>
        <div class="mt-3 flex gap-2">
          <button
            v-if="activeEvent.status === 'drafting'"
            @click="router.push('/draft')"
            class="px-4 py-2 bg-augusta text-white rounded-lg text-sm font-semibold"
          >
            Draft Room
          </button>
          <button @click="router.push('/live')" class="px-4 py-2 bg-gold text-dark rounded-lg text-sm font-semibold">
            Live Board
          </button>
        </div>
      </div>

      <!-- This week's picks -->
      <div v-if="activeEvent && weekPickRows.length" class="bg-white/90 backdrop-blur-md rounded-xl p-4 shadow border border-white/30">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs uppercase tracking-widest text-gray-500">This Week's Picks</p>
          <button @click="router.push('/live')" class="text-xs text-augusta font-semibold">Live board →</button>
        </div>
        <ul class="divide-y">
          <li v-for="r in weekPickRows" :key="r.user_id" class="py-2 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <span class="font-score text-sm text-gray-500 w-10 flex-shrink-0">
                {{ r.position_display || statusLabel(r.status) || '—' }}
              </span>
              <div class="min-w-0">
                <p class="font-semibold text-dark truncate">{{ r.golfer_name }}</p>
                <p class="text-xs text-gray-500 truncate">{{ nameById.get(r.user_id) || '…' }}</p>
              </div>
            </div>
            <div class="text-right flex-shrink-0">
              <p class="font-score font-bold text-sm" :class="r.status !== 'active' ? 'text-red-500' : 'text-dark'">
                {{ r.total_to_par_display || '—' }}
              </p>
              <p v-if="r.points > 0" class="text-xs">
                <span class="font-bold text-augusta">{{ r.points }}</span>
                <span class="text-gray-400"> pts</span>
              </p>
            </div>
          </li>
        </ul>
      </div>

      <!-- Upcoming event: countdown to tee-off. -->
      <div v-if="upcomingEvent && upcomingEvent.id !== activeEvent?.id" class="bg-white/90 backdrop-blur-md rounded-xl p-4 shadow border border-white/30">
        <p class="text-xs uppercase tracking-widest text-gray-500">Next Up</p>
        <h3 class="text-lg font-bold text-dark">{{ upcomingEvent.name }}</h3>
        <p class="text-sm text-gray-500">Tees off {{ upcomingEvent.start_date }}</p>
        <p v-if="activeEvent && activeEvent.status === 'in_progress'" class="mt-3 text-sm text-gray-500">
          Draft unlocks after {{ activeEvent.name }} ends ({{ activeEvent.end_date }}).
        </p>
        <div v-if="countdown" class="mt-3">
          <p class="text-[10px] uppercase tracking-widest text-gray-500">Tee off in</p>
          <p class="font-score text-2xl text-augusta">{{ countdown }}</p>
        </div>
      </div>

      <!-- Standings snapshot -->
      <div class="bg-white/90 backdrop-blur-md rounded-xl p-4 shadow border border-white/30">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs uppercase tracking-widest text-gray-500">Season Standings</p>
          <button @click="router.push('/standings')" class="text-xs text-augusta font-semibold">View all →</button>
        </div>
        <ul class="divide-y">
          <li v-for="(s, i) in standings" :key="s.user_id" class="py-2 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <span class="font-score text-gray-500 w-5">{{ i + 1 }}</span>
              <span class="font-semibold text-dark">{{ s.display_name }}</span>
            </div>
            <div class="font-score text-sm">
              <span class="text-augusta font-bold">{{ s.total_points }}</span>
              <span class="text-gray-400 text-xs"> pts · {{ s.weeks_played }}w</span>
            </div>
          </li>
        </ul>
      </div>
    </template>
    </div>
  </div>
</template>
