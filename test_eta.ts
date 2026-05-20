import { calculateEta } from './src/services/truck.service.js';
import { getSupabaseClient } from './src/services/user.service.js';
import * as dotenv from 'dotenv';
dotenv.config();

// using user coordinates (e.g. near Hsinchu Train Station)
calculateEta(24.8016, 120.9716).then(res => {
  console.log(res);
});
