require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://pcrumthbyecczeumvvzu.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function addCredits() {
    console.log('Adding credits...');
    // I need the user ID. I can find it by email.
    const { data: users, error: userError } = await supabase.auth.admin.listUsers();

    if (userError) {
        console.error('Error listing users:', userError);
        return;
    }

    const testUser = users.users.find(u => u.email === 'test@example.com');
    if (!testUser) {
        console.error('User test@example.com not found');
        return;
    }

    console.log(`Found user ${testUser.email} (${testUser.id})`);

    const { data, error } = await supabase
        .from('profiles')
        .update({ credits: 50 })
        .eq('id', testUser.id)
        .select();

    if (error) {
        console.error('Error updating credits:', error);
    } else {
        console.log('Credits updated:', data);
    }
}

addCredits();
