<script setup>
import { ref, nextTick, onMounted } from 'vue'

const props = defineProps({
  podName: { type: String, default: '' },
  namespace: { type: String, default: '' },
  container: { type: String, default: '' },
})

const commandHistory = ref([])
const historyIndex = ref(-1)
const currentInput = ref('')
const outputLines = ref([])
const terminalRef = ref(null)
const connected = ref(false)

const commands = {
  help: `Available commands:
  ls [path]      - List directory contents
  cat <file>     - Display file contents
  pwd            - Print working directory
  cd <path>      - Change directory
  echo <text>    - Print text
  env            - Show environment variables
  ps             - Show running processes
  top            - Show resource usage
  df             - Show disk usage
  netstat        - Show network connections
  whoami         - Show current user
  hostname       - Show hostname
  uptime         - Show system uptime
  date           - Show current date
  clear          - Clear terminal
  exit           - Close terminal`,
}

const fakeFs = {
  '/': ['app', 'bin', 'dev', 'etc', 'home', 'proc', 'root', 'tmp', 'usr', 'var'],
  '/app': ['config', 'node_modules', 'package.json', 'src', 'Dockerfile', '.env'],
  '/app/src': ['index.js', 'router.js', 'controllers', 'models', 'utils'],
  '/app/config': ['default.json', 'production.json'],
  '/etc': ['hosts', 'resolv.conf', 'hostname', 'passwd'],
}

let currentDir = '/app'

function addOutput(text, type = 'output') {
  outputLines.value.push({ text, type, timestamp: new Date().toISOString().substr(11, 12) })
  nextTick(() => {
    if (terminalRef.value) terminalRef.value.scrollTop = terminalRef.value.scrollHeight
  })
}

function executeCommand(cmd) {
  const trimmed = cmd.trim()
  if (!trimmed) return

  addOutput(`${currentDir} $ ${trimmed}`, 'command')
  commandHistory.value.push(trimmed)
  historyIndex.value = commandHistory.value.length

  const parts = trimmed.split(/\s+/)
  const command = parts[0]
  const args = parts.slice(1)

  switch (command) {
    case 'ls':
      const path = args[0] ? (args[0].startsWith('/') ? args[0] : `${currentDir}/${args[0]}`) : currentDir
      const files = fakeFs[path]
      if (files) addOutput(files.join('  '))
      else addOutput(`ls: cannot access '${args[0] || path}': No such file or directory`, 'error')
      break
    case 'cat':
      if (!args[0]) { addOutput('cat: missing file operand', 'error'); break }
      if (args[0].includes('package.json')) addOutput('{\n  "name": "frontend-api",\n  "version": "2.4.1",\n  "main": "src/index.js",\n  "scripts": {\n    "start": "node src/index.js",\n    "dev": "nodemon src/index.js"\n  },\n  "dependencies": {\n    "express": "^4.18.2",\n    "pg": "^8.11.3",\n    "redis": "^4.6.7"\n  }\n}')
      else if (args[0].includes('.env')) addOutput('NODE_ENV=production\nPORT=8080\nDB_HOST=postgres-main-svc\nDB_PORT=5432\nREDIS_URL=redis://redis-svc:6379\nLOG_LEVEL=info')
      else if (args[0].includes('hostname')) addOutput(props.podName || 'frontend-api-v1-848')
      else addOutput(`cat: ${args[0]}: No such file or directory`, 'error')
      break
    case 'pwd': addOutput(currentDir); break
    case 'cd':
      if (!args[0] || args[0] === '~') currentDir = '/root'
      else if (args[0] === '..') currentDir = currentDir.split('/').slice(0, -1).join('/') || '/'
      else if (args[0].startsWith('/')) currentDir = args[0]
      else currentDir = `${currentDir}/${args[0]}`.replace(/\/+/g, '/')
      break
    case 'echo': addOutput(args.join(' ')); break
    case 'env':
      addOutput(`NODE_ENV=production\nHOME=/root\nHOSTNAME=${props.podName || 'pod'}\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nLANG=C.UTF-8\nPORT=8080`)
      break
    case 'ps':
      addOutput(`  PID TTY          TIME CMD\n    1 ?        00:00:02 node\n   45 ?        00:00:00 /bin/sh\n  128 ?        00:00:00 ps`)
      break
    case 'top':
      addOutput(`Tasks:   3 total,   1 running,   2 sleeping\n%Cpu(s):  ${Math.floor(Math.random()*30+10)}.0 us,  ${Math.floor(Math.random()*5)}.${Math.floor(Math.random()*9)} sy,  0.0 ni, ${Math.floor(Math.random()*50+50)}.${Math.floor(Math.random()*9)} id\nMiB Mem:  512.0 total,  ${Math.floor(Math.random()*200+100)}.${Math.floor(Math.random()*9)} free,  ${Math.floor(Math.random()*200+100)}.${Math.floor(Math.random()*9)} used,  ${Math.floor(Math.random()*50)}.${Math.floor(Math.random()*9)} buff/cache\n  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM   COMMAND\n    1 root      20   0  512000 128000  32000 S  ${Math.floor(Math.random()*20+5)}.${Math.floor(Math.random()*9)}  ${Math.floor(Math.random()*30+10)}.${Math.floor(Math.random()*9)}  node`)
      break
    case 'df':
      addOutput(`Filesystem     1K-blocks    Used Available Use% Mounted on\noverlay         51200000 24100000  27100000  47% /\ntmpfs             524288        0    524288   0% /dev/shm\n/dev/sda1       51200000 24100000  27100000  47% /etc/hosts`)
      break
    case 'netstat':
      addOutput(`Active Internet connections\nProto Recv-Q Send-Q Local Address           Foreign Address         State\ntcp        0      0 0.0.0.0:8080            0.0.0.0:*               LISTEN\ntcp        0      0 127.0.0.1:8080          127.0.0.1:42354         ESTABLISHED`)
      break
    case 'whoami': addOutput('root'); break
    case 'hostname': addOutput(props.podName || 'frontend-api-v1-848'); break
    case 'uptime': addOutput(`up ${Math.floor(Math.random()*30+1)} days, ${Math.floor(Math.random()*24)}:${Math.floor(Math.random()*60).toString().padStart(2,'0')}, 0 users, load average: 0.${Math.floor(Math.random()*99)}, 0.${Math.floor(Math.random()*99)}, 0.${Math.floor(Math.random()*99)}`); break
    case 'date': addOutput(new Date().toString()); break
    case 'clear': outputLines.value = []; break
    case 'exit': addOutput('Connection closed.', 'info'); connected.value = false; break
    case 'kubectl':
      addOutput(`kubectl: command not found in container. Use the dashboard for kubectl operations.`, 'error')
      break
    case 'help': addOutput(commands.help, 'info'); break
    default:
      addOutput(`bash: ${command}: command not found. Type 'help' for available commands.`, 'error')
  }
}

function handleKeydown(e) {
  if (e.key === 'Enter') {
    executeCommand(currentInput.value)
    currentInput.value = ''
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (historyIndex.value > 0) {
      historyIndex.value--
      currentInput.value = commandHistory.value[historyIndex.value] || ''
    }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (historyIndex.value < commandHistory.value.length - 1) {
      historyIndex.value++
      currentInput.value = commandHistory.value[historyIndex.value] || ''
    } else {
      historyIndex.value = commandHistory.value.length
      currentInput.value = ''
    }
  } else if (e.key === 'Tab') {
    e.preventDefault()
    // Simple tab completion
    const parts = currentInput.value.split(/\s+/)
    const last = parts[parts.length - 1]
    const cmds = Object.keys(commands).split('\n').map(l => l.trim().split(/\s+/)[0]).concat(['ls','cat','pwd','cd','echo','env','ps','top','df','netstat','whoami','hostname','uptime','date','clear','exit','help'])
    const match = cmds.find(c => c.startsWith(last))
    if (match) {
      parts[parts.length - 1] = match
      currentInput.value = parts.join(' ')
    }
  }
}

function connect() {
  connected.value = true
  addOutput(`Connecting to ${props.podName} in ${props.namespace}...`, 'info')
  addOutput(`Connected to container: ${props.container || 'main'}`, 'info')
  addOutput(`Type 'help' for available commands.`, 'info')
  addOutput('')
}
</script>

<template>
  <div class="flex flex-col bg-[#0b1c30] rounded-lg overflow-hidden border border-outline-variant/20">
    <!-- Connection bar -->
    <div v-if="!connected" class="flex items-center justify-center gap-md p-xl">
      <button @click="connect" class="px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 flex items-center gap-sm">
        <span class="material-symbols-outlined">terminal</span> Connect to Terminal
      </button>
    </div>

    <!-- Terminal -->
    <template v-else>
      <!-- Terminal header -->
      <div class="flex items-center justify-between px-md py-xs bg-[#1a1c1e] border-b border-outline-variant/20">
        <div class="flex items-center gap-sm">
          <div class="flex gap-1">
            <span class="w-2.5 h-2.5 rounded-full bg-error/70"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-tertiary-fixed-dim/70"></span>
            <span class="w-2.5 h-2.5 rounded-full bg-primary-container/70"></span>
          </div>
          <span class="text-code-sm text-on-surface-variant ml-sm">{{ podName }}:{{ container || 'main' }}</span>
        </div>
        <div class="flex items-center gap-sm">
          <span class="w-2 h-2 rounded-full bg-primary-container animate-pulse-status"></span>
          <span class="text-body-sm text-primary">Connected</span>
        </div>
      </div>

      <!-- Output area -->
      <div ref="terminalRef" class="p-md font-mono text-code-sm overflow-y-auto" style="max-height: 500px; min-height: 300px">
        <div v-for="(line, i) in outputLines" :key="i" class="leading-[20px]">
          <span v-if="line.type === 'command'" class="text-secondary-fixed-dim">{{ line.text }}</span>
          <span v-else-if="line.type === 'error'" class="text-error">{{ line.text }}</span>
          <span v-else-if="line.type === 'info'" class="text-primary-container">{{ line.text }}</span>
          <span v-else class="text-surface-variant">{{ line.text }}</span>
        </div>
        <!-- Input line -->
        <div class="flex items-center leading-[20px]">
          <span class="text-secondary-fixed-dim shrink-0">{{ currentDir }} $&nbsp;</span>
          <input
            ref="terminalRef"
            v-model="currentInput"
            @keydown="handleKeydown"
            class="flex-1 bg-transparent text-surface-variant outline-none font-mono text-code-sm caret-primary"
            spellcheck="false"
            autocomplete="off"
          />
          <span class="w-1.5 h-4 bg-primary inline-block animate-pulse"></span>
        </div>
      </div>
    </template>
  </div>
</template>
