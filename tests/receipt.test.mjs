// Texts modelled on real receipts of the DELFT mission (May 2026), as OCR or a PDF
// text layer would return them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAmount, findDates, findDate, findTime, guessCategory, readReceipt, repliconType, categoryOfTitle } from '../receipt.js';

const SNCF = `JUSTIFICATIF D'ACHAT
Ce document ne constitue pas un titre de transport
Gare de PRINGY 19/05/26 à 08H49
Carte n°
Billet Tarif Normal Régional
De PRINGY HTE SAVOIE à ANNECY
Utilisable le 19/05/2026
Classe 2
Prix: € **2,10`;

const NS = `Order overview
Rotterdam Centraal
NS
Delft
Tuesday 19 May 2026
1 adult
1x One-way ticket, 2nd class € 4.40
L. TAGUEMA
Order details
Order date 19 may 2026
Order number E543206105
Payment method Visa
Total € 4.40`;

const CAFE = `SSP France
PAUL
PLACE LOUIS ARMAND 75012 PARIS
19 May'26
Take Out
1 Wr Spicy Tuna Bolos Demo 21.90
1 Avocado House Toast 6.50
Net Total: 18.18
Food 25.25
Beverage 3.15
Paiement 28.40
Change Due €0.00
CARTE BANCAIRE SANS CONTACT
LE 19/05/26 A 13:27:30
MONTANT 28,40 EUR`;

const HOTEL = `Grand Museum Hotel, BW Signature Collection
Check-in 19/05/2026 Check-out 22/05/2026
3 nuits x 140,00
Sous-total 420,00
Taxe de séjour 12,30
TVA 9% 34,68
Total TTC 432,30 EUR
Espèces rendu 0,00`;

test('amount: keyword lines win, VAT / subtotal / change are ignored', () => {
  assert.equal(findAmount(SNCF), '2.10');
  assert.equal(findAmount(NS), '4.40');
  assert.equal(findAmount(CAFE), '28.40');
  assert.equal(findAmount(HOTEL), '432.30');
  assert.equal(findAmount('Totaal\n€ 12,50'), '12.50'); // amount on the next line
  assert.equal(findAmount('1 234,56 EUR'), '1234.56');
  assert.equal(findAmount('no amount here'), '');
});

test('dates: day-first, US order, month names in FR / EN / NL, invalid ones rejected', () => {
  assert.deepEqual(findDates(SNCF), ['2026-05-19', '2026-05-19']);
  assert.equal(findDates(NS)[0], '2026-05-19');
  assert.deepEqual(findDates('05/19/26'), ['2026-05-19']);
  assert.deepEqual(findDates('le 3 nov. 2025'), ['2025-11-03']);
  assert.deepEqual(findDates('22 mei 2026'), ['2026-05-22']);
  assert.deepEqual(findDates('31/02/2026'), []);
  assert.deepEqual(findDates('2026-05-22'), ['2026-05-22']);
});

test('date: prefers a date inside the mission', () => {
  const t = 'Carte valable du 3 nov. 2025 au 3 nov. 2026\nAchat le 20/05/2026';
  assert.equal(findDate(t), '2025-11-03');
  assert.equal(findDate(t, { start: '2026-05-19', end: '2026-05-22' }), '2026-05-20');
});

test('time', () => {
  assert.equal(findTime(SNCF), '08:49');
  assert.equal(findTime(CAFE), '13:27');
  assert.equal(findTime('no time'), '');
});

test('category guesses', () => {
  assert.equal(guessCategory(SNCF), 'Train');
  assert.equal(guessCategory(NS), 'Train');
  assert.equal(guessCategory(CAFE), 'Repas midi');
  assert.equal(guessCategory(CAFE.replace('13:27:30', '20:05:00')), 'Repas soir');
  assert.equal(guessCategory(HOTEL), 'Taxe de séjour'); // tourist tax line comes first in the rules
  assert.equal(guessCategory('Uber trip receipt'), 'Taxi');
  assert.equal(guessCategory('rien'), '');
});

test('readReceipt and Replicon types', () => {
  assert.deepEqual(readReceipt(CAFE, { start: '2026-05-19', end: '2026-05-22' }),
    { amount: '28.40', date: '2026-05-19', time: '13:27', category: 'Repas midi' });
  assert.equal(repliconType('Train'), 'Avions, trains, métros');
  assert.equal(repliconType('Repas midi'), 'Avance');
  assert.equal(categoryOfTitle('Repas midi 2'), 'Repas midi');
  assert.equal(categoryOfTitle('Train régional'), 'Train');
  assert.equal(categoryOfTitle('Divers'), '');
});
