<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import type {
  WeeklyEventRow as WeeklyEvent,
  DraftStateRow as DraftState,
  PickRow as Pick,
  LeaderboardSnapshotRow as Snapshot,
  ProfileRow as Profile,
} from '@/types/database'
import type { RealtimeChannel } from '@supabase/supabase-js'

const auth = useAuthStore()

const event = ref<WeeklyEvent | null>(null)
const blockingEvent = ref<WeeklyEvent | null>(null)
const draftState = ref<DraftState | null>(null)
const picks = ref<Pick[]>([])
const field = ref<Snapshot[]>([])
const members = ref<Profile[]>([])
const usedThisSeason = ref<Set<string>>(new Set())
const loading = ref(true)
const error = ref('')
const search = ref('')
const submitting = ref(false)

let channels: RealtimeChannel[] = []

const nameById = computed(() => {
  const m = new Map<string, string>()
  for (const p of members.value) m.set(p.id, (p.display_name ?? '').trim() || 'Unknown')
  return m
})

const currentPickUserId = computed(() => {
  const ds = draftState.value
  if (!ds || ds.status !== 'active') return null
  return ds.draft_order[ds.current_pick_index] ?? null
})

const isMyTurn = computed(() => currentPickUserId.value && currentPickUserId.value === auth.user?.id)

const pickedGolferIds = computed(() => new Set(picks.value.map(p => p.golfer_espn_id)))

const filteredField = computed(() => {
  const q = search.value.trim().toLowerCase()
  return field.value.filter(g => {
    if (pickedGolferIds.value.has(g.golfer_espn_id)) return false
    if (usedThisSeason.value.has(g.golfer_espn_id)) return false
    if (g.status !== 'active') return false
    if (!q) return true
    return g.golfer_name.toLowerCase().includes(q)
  })
})

async function loadEvent() {
  loading.value = true
  error.value = ''
  event.value = null
  blockingEvent.value = null

  // If a tournament is currently in_progress, the next draft is hidden until
  // it finishes. Surface the blocker so the UI can explain.
  const { data: inProg } = await supabase
    .from('weekly_events')
    .select('*')
    .eq('status', 'in_progress')
    .order('start_date', { ascending: false })
    .limit(1)
  const blocker = (inProg?.[0] ?? null) as WeeklyEvent | null

  // Show a draft room for an event that is actively drafting first
  const { data: drafting } = await supabase
    .from('weekly_events')
    .select('*')
    .eq('status', 'drafting')
    .order('start_date', { ascending: true })
    .limit(1)
  let current = (drafting?.[0] ?? null) as WeeklyEvent | null

  // If nothing is drafting and no event is in_progress, show the next upcoming
  if (!current && !blocker) {
    const { data: upcoming } = await supabase
      .from('weekly_events')
      .select('*')
      .eq('status', 'upcoming')
      .order('start_date', { ascending: true })
      .limit(1)
    current = (upcoming?.[0] ?? null) as WeeklyEvent | null
  }

  if (!current) {
    blockingEvent.value = blocker
    loading.value = false
    return
  }

  event.value = current
  await Promise.all([loadDraftState(), loadPicks(), loadField(), loadMembers(), loadUsed()])
  loading.value = false
}

async function loadDraftState() {
  if (!event.value) return
  const { data } = await supabase
    .from('draft_state')
    .select('*')
    .eq('event_id', event.value.id)
    .maybeSingle()
  draftState.value = data as DraftState | null
}

async function loadPicks() {
  if (!event.value) return
  const { data } = await supabase
    .from('picks')
    .select('*')
    .eq('event_id', event.value.id)
    .order('pick_number', { ascending: true })
  picks.value = (data ?? []) as Pick[]
}

async function loadField() {
  if (!event.value) return
  const { data } = await supabase
    .from('leaderboard_snapshots')
    .select('*')
    .eq('event_id', event.value.id)
    .order('position_numeric', { ascending: true, nullsFirst: false })
    .limit(250)
  field.value = (data ?? []) as Snapshot[]
}

async function loadMembers() {
  const { data: seasons } = await supabase.from('seasons').select('id').eq('status', 'active').single()
  if (!seasons) return
  const { data: lm } = await supabase
    .from('league_members')
    .select('user_id, display_order, profiles:profiles!inner(id,display_name,created_at)')
    .eq('season_id', seasons.id)
    .order('display_order', { ascending: true })
  members.value = (lm ?? []).map((r: any) => r.profiles).filter(Boolean) as Profile[]
}

async function loadUsed() {
  if (!auth.user || !event.value) return
  const { data: season } = await supabase.from('seasons').select('id').eq('status', 'active').single()
  if (!season) return
  const { data } = await supabase
    .from('picks')
    .select('golfer_espn_id, weekly_events!inner(season_id)')
    .eq('user_id', auth.user.id)
    .eq('weekly_events.season_id', season.id)
  usedThisSeason.value = new Set(((data ?? []) as any[]).map(r => r.golfer_espn_id))
}

async function startDraft() {
  if (!event.value) return
  submitting.value = true
  error.value = ''
  const { error: rpcErr } = await supabase.rpc('start_weekly_draft', { p_event_id: event.value.id })
  if (rpcErr) error.value = rpcErr.message
  submitting.value = false
  await loadDraftState()
  await loadEvent()
}

async function makePick(g: Snapshot) {
  if (!event.value || !isMyTurn.value || submitting.value) return
  submitting.value = true
  error.value = ''
  const { error: rpcErr } = await supabase.rpc('make_weekly_pick', {
    p_event_id: event.value.id,
    p_golfer_espn_id: g.golfer_espn_id,
    p_golfer_name: g.golfer_name,
  })
  if (rpcErr) error.value = rpcErr.message
  submitting.value = false
}

function subscribe() {
  // Global listener for any weekly_events change so the draft unlocks when
  // the in-progress tournament finishes.
  channels.push(
    supabase.channel(`draft-events-global`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_events' }, () => loadEvent())
      .subscribe()
  )
  if (!event.value) return
  channels.push(
    supabase.channel(`draft:${event.value.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_state', filter: `event_id=eq.${event.value.id}` }, () => loadDraftState())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picks', filter: `event_id=eq.${event.value.id}` }, () => { loadPicks(); loadUsed() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leaderboard_snapshots', filter: `event_id=eq.${event.value.id}` }, () => loadField())
      .subscribe()
  )
}

onMounted(async () => {
  await loadEvent()
  subscribe()
})

onUnmounted(() => {
  channels.forEach(c => supabase.removeChannel(c))
  channels = []
})

watch(() => event.value?.id, (id, prev) => {
  if (id && id !== prev) {
    channels.forEach(c => supabase.removeChannel(c))
    channels = []
    subscribe()
  }
})
</script>

<template>
  <div class="max-w-3xl mx-auto p-4 space-y-4">
    <div v-if="loading" class="text-center text-gray-500 py-12">Loading draft…</div>

    <div v-else-if="!event && blockingEvent" class="text-center py-12 bg-white rounded-xl shadow px-6">
      <p class="text-4xl mb-3">⏳</p>
      <p class="text-lg font-semibold text-dark">Draft opens after {{ blockingEvent.name }}</p>
      <p class="text-sm text-gray-500 mt-2">
        The next draft will be available once this week's tournament wraps up ({{ blockingEvent.end_date }}).
      </p>
    </div>

    <div v-else-if="!event" class="text-center py-12 bg-white rounded-xl shadow">
      <p class="text-lg font-semibold text-dark">No upcoming event</p>
      <p class="text-sm text-gray-500 mt-2">A new PGA event will appear here automatically each week.</p>
    </div>

    <template v-else>
      <!-- Event header -->
      <div class="bg-augusta-gradient text-white rounded-xl p-4 shadow">
        <p class="text-xs uppercase tracking-widest text-cream/70">This Week's Event</p>
        <h2 class="text-2xl font-bold">{{ event.name }}</h2>
        <p class="text-sm text-cream/80 mt-1">{{ event.start_date }} → {{ event.end_date }}</p>
        <p class="mt-2 inline-block px-2 py-0.5 rounded bg-white/10 text-xs uppercase tracking-wider">{{ event.status.replace('_', ' ') }}</p>
      </div>

      <!-- Start draft CTA or draft state -->
      <div v-if="!draftState || draftState.status === 'pending'" class="bg-white rounded-xl p-6 shadow text-center">
        <p class="text-gray-700 mb-4">Draft has not been started yet. Any league member can kick it off.</p>
        <button
          @click="startDraft"
          :disabled="submitting"
          class="px-6 py-3 bg-augusta text-white rounded-lg font-semibold uppercase tracking-wide hover:bg-augusta-dark disabled:opacity-60"
        >
          {{ submitting ? 'Starting…' : 'Start Draft' }}
        </button>
      </div>

      <!-- Draft order + on-the-clock -->
      <div v-else class="bg-white rounded-xl p-4 shadow">
        <p class="text-xs uppercase tracking-widest text-gray-500 mb-2">Draft Order (last place picks first)</p>
        <div class="flex gap-2 overflow-x-auto no-scrollbar pb-1">
          <div
            v-for="(uid, i) in draftState.draft_order"
            :key="uid"
            class="flex-shrink-0 px-3 py-2 rounded-lg border-2 text-sm"
            :class="[
              i === draftState.current_pick_index && draftState.status === 'active'
                ? 'border-gold bg-gold/10 text-dark font-bold'
                : i < draftState.current_pick_index
                  ? 'border-gray-200 bg-gray-50 text-gray-500 line-through'
                  : 'border-gray-200 bg-white text-gray-700'
            ]"
          >
            <span class="text-xs text-gray-500 mr-1">#{{ i + 1 }}</span>
            {{ nameById.get(uid) || '…' }}
          </div>
        </div>

        <div v-if="draftState.status === 'active'" class="mt-3 pt-3 border-t">
          <p v-if="isMyTurn" class="text-augusta font-bold text-center">You're on the clock. Pick a golfer below.</p>
          <p v-else class="text-gray-600 text-center">
            On the clock: <span class="font-semibold text-dark">{{ nameById.get(currentPickUserId || '') || '…' }}</span>
          </p>
        </div>

        <p v-else-if="draftState.status === 'completed'" class="mt-3 pt-3 border-t text-center text-augusta font-bold">
          Draft complete ✓
        </p>
      </div>

      <!-- Error -->
      <div v-if="error" class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
        {{ error }}
      </div>

      <!-- Current picks -->
      <div v-if="picks.length" class="bg-white rounded-xl p-4 shadow">
        <p class="text-xs uppercase tracking-widest text-gray-500 mb-2">Picks So Far</p>
        <ul class="divide-y">
          <li v-for="p in picks" :key="p.id" class="py-2 flex items-center justify-between">
            <div>
              <p class="font-semibold text-dark">{{ p.golfer_name }}</p>
              <p class="text-xs text-gray-500">Pick #{{ p.pick_number }} · {{ nameById.get(p.user_id) || '…' }}</p>
            </div>
          </li>
        </ul>
      </div>

      <!-- Golfer field -->
      <div v-if="draftState && draftState.status === 'active'" class="bg-white rounded-xl p-4 shadow">
        <div class="flex items-center justify-between mb-3">
          <p class="text-xs uppercase tracking-widest text-gray-500">The Field</p>
          <input
            v-model="search"
            type="text"
            placeholder="Search golfers…"
            class="px-3 py-1 border rounded-lg text-sm w-40 focus:outline-none focus:ring-1 focus:ring-augusta"
          />
        </div>
        <div v-if="filteredField.length === 0" class="text-center text-gray-500 py-8 text-sm">
          No golfers match your search (or ESPN hasn't published the field yet).
        </div>
        <ul v-else class="divide-y max-h-[60vh] overflow-y-auto">
          <li v-for="g in filteredField" :key="g.golfer_espn_id" class="py-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-3">
              <span class="font-score text-sm text-gray-500 w-10">{{ g.position_display || '—' }}</span>
              <div>
                <p class="font-semibold text-dark">{{ g.golfer_name }}</p>
                <p v-if="g.total_to_par_display" class="text-xs text-gray-500 font-score">{{ g.total_to_par_display }}</p>
              </div>
            </div>
            <button
              @click="makePick(g)"
              :disabled="!isMyTurn || submitting"
              class="px-3 py-1.5 rounded-lg text-sm font-semibold uppercase tracking-wider transition"
              :class="isMyTurn
                ? 'bg-augusta text-white hover:bg-augusta-dark'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'"
            >
              Pick
            </button>
          </li>
        </ul>
        <p v-if="usedThisSeason.size" class="text-xs text-gray-400 mt-3">
          {{ usedThisSeason.size }} golfer{{ usedThisSeason.size === 1 ? '' : 's' }} already used this season are hidden.
        </p>
      </div>
    </template>
  </div>
</template>
