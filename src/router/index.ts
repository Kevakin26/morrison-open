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
  {
    path: '/',
    redirect: '/draft',
  },
  {
    path: '/dashboard',
    name: 'Dashboard',
    component: () => import('@/views/DashboardView.vue'),
  },
  {
    path: '/draft',
    name: 'Draft',
    component: () => import('@/views/DraftView.vue'),
  },
  {
    path: '/leaderboard',
    name: 'Leaderboard',
    component: () => import('@/views/LeaderboardView.vue'),
  },
  {
    path: '/my-team',
    name: 'MyTeam',
    component: () => import('@/views/MyTeamView.vue'),
  },
  {
    path: '/chat',
    name: 'Chat',
    component: () => import('@/views/ChatView.vue'),
  },
  {
    path: '/golfers',
    name: 'Golfers',
    component: () => import('@/views/GolfersView.vue'),
  },
  {
    path: '/matchup',
    name: 'Matchup',
    component: () => import('@/views/MatchupView.vue'),
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/draft',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

import { useAuthStore } from '@/stores/auth'

router.beforeEach((to, _from, next) => {
  const requiresAuth = to.meta.requiresAuth !== false
  const auth = useAuthStore()

  if (requiresAuth && !auth.isAuthenticated) {
    next('/login')
  } else if (!requiresAuth && auth.isAuthenticated && (to.name === 'Login' || to.name === 'Register')) {
    next('/draft')
  } else {
    next()
  }
})

export default router
