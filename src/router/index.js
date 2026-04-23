import { createRouter, createWebHistory } from 'vue-router'

import LayoutView from '@/views/layout/index.vue'
import LoginView from '@/views/login/index.vue'
import AlertView from '@/views/alert/index.vue'
import AlertDetailView from '@/views/alert/detail.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: LayoutView,
      redirect: '/alert',
      children: [
        { path: 'alert', name: 'alert', component: AlertView, meta: { keepAlive: true } },
        { path: 'alert/device/:id', name: 'alertDetail', component: AlertDetailView }
      ]
    },
    { path: '/login', name: 'login', component: LoginView }
  ]
})

export default router
