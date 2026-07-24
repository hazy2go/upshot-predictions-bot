import 'dotenv/config';
import { getLiveContestGoldCards } from './src/api.js';
const gold = await getLiveContestGoldCards();
const q = 'odyssey still trends higher';
const hit = gold.filter(c => (c.name||'').toLowerCase().includes('odyssey'));
console.log('gold cards found:', gold.length);
console.log('odyssey matches:', JSON.stringify(hit, null, 2));
