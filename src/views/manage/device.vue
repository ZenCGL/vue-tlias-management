<script setup>
import { reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { useMonitorCenter } from '@/views/alert/useMonitorCenter'

const { DEVICE_OPTIONS, initMonitorCenter, useMonitorCenterPage, addDevice, updateDevice, removeDevice } = useMonitorCenter()

useMonitorCenterPage()
void initMonitorCenter()

const form = reactive({
  value: null,
  name: '',
  port: ''
})

function resetForm() {
  form.value = null
  form.name = ''
  form.port = ''
}

function submitForm() {
  if (!form.name) {
    ElMessage.warning('请先填写设备名称')
    return
  }
  if (form.value != null) {
    updateDevice({ ...form })
    ElMessage.success('设备信息已更新')
  } else {
    addDevice({ ...form })
    ElMessage.success('设备已添加')
  }
  resetForm()
}

function editRow(row) {
  form.value = row.value
  form.name = row.name
  form.port = row.port
}

function removeRow(row) {
  removeDevice(row.value)
  if (form.value === row.value) {
    resetForm()
  }
  ElMessage.success('设备已删除')
}
</script>

<template>
  <div class="manage-page">
    <section class="manage-hero">
      <div>
        <div class="hero-kicker">DEVICE</div>
        <h1>设备管理</h1>
      </div>
    </section>

    <section class="manage-grid">
      <article class="panel form-panel">
        <div class="panel-head">
          <h3>{{ form.value != null ? '编辑设备' : '新增设备' }}</h3>
        </div>
        <div class="form-grid">
          <el-form-item label="设备名称">
            <el-input v-model="form.name" placeholder="例如：设备 1" />
          </el-form-item>
          <el-form-item label="串口 / 标识">
            <el-input v-model="form.port" placeholder="例如：COM3" />
          </el-form-item>
        </div>
        <div class="form-actions">
          <el-button type="primary" @click="submitForm">{{ form.value != null ? '保存修改' : '添加设备' }}</el-button>
          <el-button @click="resetForm">重置</el-button>
        </div>
      </article>

      <article class="panel table-panel">
        <div class="panel-head">
          <h3>设备列表</h3>
          <span class="count-chip">{{ DEVICE_OPTIONS.length }} 台</span>
        </div>
        <el-table :data="DEVICE_OPTIONS" stripe>
          <el-table-column prop="value" label="WorkerId" width="120" />
          <el-table-column prop="name" label="设备名称" min-width="160" />
          <el-table-column prop="port" label="串口 / 标识" min-width="140" />
          <el-table-column prop="label" label="展示名称" min-width="220" />
          <el-table-column label="操作" width="180">
            <template #default="{ row }">
              <el-button link type="primary" @click="editRow(row)">编辑</el-button>
              <el-button link type="danger" @click="removeRow(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </article>
    </section>
  </div>
</template>

<style scoped>
.manage-page {
  min-height: 100%;
  padding: 24px;
  background:
    radial-gradient(circle at top left, rgba(15, 118, 110, 0.12), transparent 28%),
    linear-gradient(180deg, #f2f8f7 0%, #edf3f2 100%);
}

.manage-hero,
.panel {
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 18px 38px rgba(23, 70, 74, 0.08);
}

.manage-hero {
  padding: 28px;
}

.hero-kicker {
  font-size: 12px;
  letter-spacing: 0.16em;
  color: #0f766e;
}

.manage-hero h1 {
  margin: 10px 0 12px;
  color: #17384d;
}

.manage-hero p {
  margin: 0;
  color: #67808f;
}

.manage-grid {
  display: grid;
  grid-template-columns: 0.9fr 1.4fr;
  gap: 20px;
  margin-top: 20px;
}

.panel {
  padding: 20px 24px;
}

.panel-head,
.form-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.panel-head h3 {
  margin: 0;
}

.form-grid {
  display: grid;
  gap: 16px;
  margin-top: 18px;
}

.form-grid :deep(.el-form-item) {
  margin-bottom: 0;
}

.form-actions {
  margin-top: 18px;
  justify-content: flex-end;
}

.count-chip {
  padding: 8px 12px;
  border-radius: 999px;
  background: #eef7f5;
  color: #0f766e;
  font-size: 13px;
}

@media (max-width: 1100px) {
  .manage-grid {
    grid-template-columns: 1fr;
  }
}
</style>
