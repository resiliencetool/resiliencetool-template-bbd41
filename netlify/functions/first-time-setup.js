// Runs once per instance, entirely self-contained — creates the
// company row and the first adviser (the person setting up), then
// sends them the exact same invite email every other adviser gets.
// They set their password through dashboard-login.html's existing
// "Set Your Password" flow — nothing new needed there.
//
// Deliberately refuses to run a second time (see the guard below),
// since this instance is single-tenant — it should only ever have
// one company.

const { createClient } = require("@supabase/supabase-js");
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function slugify(text){
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

exports.handler = async function(event, context){
  if(event.httpMethod !== "POST"){
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { companyName, ownerName, ownerEmail } = body;

    if(!companyName || !ownerName || !ownerEmail){
      return { statusCode: 400, body: JSON.stringify({ error: "Company name, your name, and your email are all required" }) };
    }

    // Guard against a second company existing in this single-tenant
    // instance — but allow a genuine mistake (wrong email, typo'd
    // company name) to be corrected freely, right up until someone has
    // actually confirmed their invite and logged in for real. Once
    // that's happened, this locks permanently — a live company should
    // never be silently wiped.
    const { data: existingCompanies, error: fetchError } = await supabaseAdmin
      .from("companies")
      .select("id");

    if(fetchError){
      return { statusCode: 500, body: JSON.stringify({ error: fetchError.message }) };
    }

    if(existingCompanies && existingCompanies.length > 0){
      const existingCompanyId = existingCompanies[0].id;

      const { data: existingAdvisers, error: advisersFetchError } = await supabaseAdmin
        .from("advisers")
        .select("id, auth_user_id")
        .eq("company_id", existingCompanyId);

      if(advisersFetchError){
        return { statusCode: 500, body: JSON.stringify({ error: advisersFetchError.message }) };
      }

      let anyoneHasLoggedIn = false;
      for(const adviser of (existingAdvisers || [])){
        if(!adviser.auth_user_id) continue;
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(adviser.auth_user_id);
        if(authUser?.user?.email_confirmed_at){
          anyoneHasLoggedIn = true;
          break;
        }
      }

      if(anyoneHasLoggedIn){
        return { statusCode: 409, body: JSON.stringify({ error: "Setup has already been completed for this instance. Please log in instead." }) };
      }

      // Nobody has confirmed yet — safe to treat this as a redo. Clean
      // up the unconfirmed draft before creating the corrected version.
      for(const adviser of (existingAdvisers || [])){
        if(adviser.auth_user_id){
          await supabaseAdmin.auth.admin.deleteUser(adviser.auth_user_id);
        }
      }
      await supabaseAdmin.from("advisers").delete().eq("company_id", existingCompanyId);
      await supabaseAdmin.from("companies").delete().eq("id", existingCompanyId);
    }

    const companySlug = slugify(companyName);

    const { data: newCompany, error: companyError } = await supabaseAdmin
      .from("companies")
      .insert({
        company_name: companyName,
        company_slug: companySlug,
        company_email: ownerEmail,
        primary_colour: "#132869",
        secondary_colour: "#e8edf7",
        active: true
      })
      .select()
      .single();

    if(companyError){
      return { statusCode: 500, body: JSON.stringify({ error: companyError.message }) };
    }

    const ownerSlug = slugify(ownerName);

    const { data: newAdviser, error: adviserError } = await supabaseAdmin
      .from("advisers")
      .insert({
        adviser_name: ownerName,
        adviser_email: ownerEmail,
        adviser_slug: ownerSlug,
        company_id: newCompany.id,
        active: true,
        invite_status: "pending"
      })
      .select()
      .single();

    if(adviserError){
      // Roll back the company row rather than leave an orphaned company
      // with no adviser — a clean failure is better than a half-created
      // instance someone has to spot and fix manually later.
      await supabaseAdmin.from("companies").delete().eq("id", newCompany.id);
      return { statusCode: 500, body: JSON.stringify({ error: adviserError.message }) };
    }

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.inviteUserByEmail(ownerEmail);
    const newStatus = authError ? "failed" : "sent";
    if(authError){
      console.error("Invite failed for", ownerEmail, authError);
    }

    await supabaseAdmin
      .from("advisers")
      .update({
        invite_status: newStatus,
        auth_user_id: authData?.user?.id || null
      })
      .eq("id", newAdviser.id);

    return { statusCode: 200, body: JSON.stringify({ success: true, inviteStatus: newStatus }) };

  } catch(err){
    console.error("first-time-setup error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
