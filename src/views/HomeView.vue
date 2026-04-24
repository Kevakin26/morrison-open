<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'
import type { WeeklyEventRow as WeeklyEvent, SeasonStandingRow as Standing } from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

const router = useRouter()

const activeEvent = ref<WeeklyEvent | null>(null)
const upcomingEvent = ref<WeeklyEvent | null>(null)
const standings = ref<Standing[]>([])
const loading = ref(true)

let channel: RealtimeChannel | null = null

async function load() {
  loading.value = true

  const [{ data: events }, { data: s }] = await Promise.all([
    supabase.from('weekly_events').select('*').order('start_date', { ascending: true }).limit(20),
    supabase.from('season_standings').select('*'),
  ])

  activeEvent.value = (events ?? []).find(e => ['drafting', 'in_progress'].includes(e.status)) ?? null
  upcomingEvent.value = (events ?? []).find(e => e.status === 'upcoming') ?? null
  standings.value = (s ?? []) as Standing[]
  loading.value = false
}

const countdown = ref('')
let timer: ReturnType<typeof setInterval> | null = null

const draftTarget = computed(() => {
  // draft happens Wednesday before the tournament's start_date (Thursday)
  const ev = activeEvent.value?.status === 'drafting' ? activeEvent.value : upcomingEvent.value
  if (!ev) return null
  const start = new Date(ev.start_date + 'T00:00:00Z')
  // 1 day earlier + 7pm MST (02:00 UTC next day) -> use Wed 7pm local
  const draft = new Date(start)
  draft.setUTCDate(draft.getUTCDate() - 1)
  draft.setUTCHours(2, 0, 0, 0) // ~7 PM MST
  return draft
})

function tick() {
  if (!draftTarget.value) { countdown.value = ''; return }
  const diff = draftTarget.value.getTime() - Date.now()
  if (diff <= 0) { countdown.value = 'Draft is open'; return }
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
  channel = supabase.channel('home')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_events' }, load)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_results' }, load)
    .subscribe()
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (channel) supabase.removeChannel(channel)
})
</script>

<template>
  <div class="max-w-3xl mx-auto p-4 space-y-4">
    <div v-if="loading" class="text-center text-gray-500 py-12">Loading…</div>

    <template v-else>
      <!-- Hero -->
      <div class="bg-augusta-gradient text-white rounded-xl p-5 shadow-lg">
        <p class="text-xs uppercase tracking-widest text-cream/70">Morrison Open · 2026 Season</p>
        <h1 class="text-3xl font-bold mt-1">Every week. One pick. One winner.</h1>
        <p class="text-cream/80 text-sm mt-2">
          Each week, every player drafts a single PGA golfer. Low cumulative points wins the season.
        </p>
      </div>

      <!-- Active event card -->
      <div v-if="activeEvent" class="bg-white rounded-xl p-4 shadow">
        <p class="text-xs uppercase tracking-widest text-gray-500">This Week</p>
        <h2 class="text-xl font-bold text-dark">{{ activeEvent.name }}</h2>
        <p class="text-sm text-gray-500">{{ activeEvent.start_date }} → {{ activeEvent.end_date }}</p>
        <div class="mt-3 flex gap-2">
          <button @click="router.push('/draft')" class="px-4 py-2 bg-augusta text-white rounded-lg text-sm font-semibold">
            Draft Room
          </button>
          <button @click="router.push('/live')" class="px-4 py-2 bg-gold text-dark rounded-lg text-sm font-semibold">
            Live Board
          </button>
        </div>
      </div>

      <!-- Upcoming / next-draft countdown -->
      <div v-if="upcomingEvent && upcomingEvent.id !== activeEvent?.id" class="bg-white rounded-xl p-4 shadow">
        <p class="text-xs uppercase tracking-widest text-gray-500">Next Draft</p>
        <h3 class="text-lg font-bold text-dark">{{ upcomingEvent.name }}</h3>
        <p class="text-sm text-gray-500">Tees off {{ upcomingEvent.start_date }}</p>
        <p v-if="countdown" class="mt-3 font-score text-2xl text-augusta">{{ countdown }}</p>
      </div>

      <!-- Standings snapshot -->
      <div class="bg-white rounded-xl p-4 shadow">
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
</template>
