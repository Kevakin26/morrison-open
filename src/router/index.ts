import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { requiresAuth: false },
  },
  { path: '/', redirect: '/home' },
  {
    path: '/home',
    name: 'Home',
    component: () => import('@/views/HomeView.vue'),
  },
  {
    path: '/draft',
    name: 'Draft',
    component: () => import('@/views/DraftView.vue'),
  },
  {
    path: '/live',
    name: 'Live',
    component: () => import('@/views/LiveBoardView.vue'),
  },
  {
    path: '/standings',
    name: 'Standings',
    component: () => import('@/views/StandingsView.vue'),
  },
  {
    path: '/history',
    name: 'History',
    component: () => import('@/views/HistoryView.vue'),
  },
  {
    path: '/chat',
    name: 'Chat',
    component: () => import('@/views/ChatView.vue'),
  },
  { path: '/:pathMatch(.*)*', redirect: '/home' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

import { useAuthStore } from '@/stores/auth'
import { watch } from 'vue'

function waitForAuth(auth: ReturnType<typeof useAuthStore>): Promise<void> {
  if (!auth.loading) return Promise.resolve()
  return new Promise(resolve => {
    const stop = watch(() => auth.loading, (loading) => {
      if (!loading) { stop(); resolve() }
    })
  })
}

router.beforeEach(async (to, _from, next) => {
  const requiresAuth = to.meta.requiresAuth !== false
  const auth = useAuthStore()

  await waitForAuth(auth)

  if (requiresAuth && !auth.isAuthenticated) {
    next('/login')
  } else if (!requiresAuth && auth.isAuthenticated && (to.name === 'Login' || to.name === 'Register')) {
    next('/home')
  } else {
    next()
  }
})

export default router
