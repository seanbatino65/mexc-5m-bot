FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY data/alert_config.json ./data/alert_config.json
COPY data/paper_trading_state.json ./data/paper_trading_state.json
COPY data/latest_backtest_report.json ./data/latest_backtest_report.json

ENV PORT=3470
EXPOSE 3470

CMD ["node", "src/server.js"]
