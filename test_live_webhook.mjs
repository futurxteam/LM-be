import axios from 'axios'

async function test() {
  const payload = {
    object: 'page',
    entry: [
      {
        id: '535206066342370',
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: 'leadgen',
            value: {
              form_id: '611941894576451',
              leadgen_id: '1463809155256450',
              created_time: Math.floor(Date.now() / 1000),
              page_id: '535206066342370',
            },
          },
        ],
      },
    ],
  }

  console.log('Sending webhook payload to Render...')
  const res = await axios.post('https://lm-be-yx0a.onrender.com/api/meta/webhook', payload)
  console.log('Response:', res.data)
}

test().catch(err => console.error(err.response?.data || err.message))

