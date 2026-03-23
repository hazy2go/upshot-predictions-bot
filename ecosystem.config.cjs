module.exports = {
  apps: [{
    name: 'upshot-predictions',
    script: 'src/index.js',
    node_args: '--env-file=.env',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
