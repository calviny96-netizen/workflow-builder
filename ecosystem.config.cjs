module.exports = {
  apps: [{
    name: 'workflow-builder',
    cwd: '/home/oem/workflow-builder',
    script: '/usr/bin/sg',
    args: ['docker', '-c', '/bin/bash /home/oem/workflow-builder/scripts/docker-watchdog.sh'],
    interpreter: 'none',
    autorestart: true,
    restart_delay: 5000,
    min_uptime: 10000,
    max_restarts: 100,
    kill_timeout: 5000,
    time: true,
    out_file: '/home/oem/workflow-builder/.data/pm2-out.log',
    error_file: '/home/oem/workflow-builder/.data/pm2-error.log',
  }],
};
