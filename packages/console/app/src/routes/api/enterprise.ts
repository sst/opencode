import type { APIEvent } from "@solidjs/start/server"
import { AWS } from "@opencode-ai/console-core/aws.js"
import { Resource } from "@opencode-ai/console-resource"
import { i18n } from "~/i18n"
import { localeFromRequest } from "~/lib/language"
import { createLead } from "~/lib/salesforce"

interface EnterpriseFormData {
  name: string
  role: string
  company?: string
  email: string
  phone?: string
  alias?: string
  message: string
}

const EMAIL_OCTOPUS_LIST_ID = "1b381e5e-39bd-11f1-ba4a-cdd4791f0c43"

function splitFullName(fullName: string) {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0)
  if (parts.length === 0) return { firstName: "", lastName: "" }
  if (parts.length === 1) return { firstName: parts[0], lastName: "" }
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") }
}

function subscribe(email: string, fullName: string) {
  const name = splitFullName(fullName)
  const fields: Record<string, string> = {}
  if (name.firstName) fields.FirstName = name.firstName
  if (name.lastName) fields.LastName = name.lastName

  const payload: { email_address: string; fields?: Record<string, string> } = { email_address: email }
  if (Object.keys(fields).length) payload.fields = fields

  return fetch(`https://api.emailoctopus.com/lists/${EMAIL_OCTOPUS_LIST_ID}/contacts`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${Resource.EMAILOCTOPUS_API_KEY.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }).then(
    async (res) => {
      if (!res.ok) {
        console.error("EmailOctopus subscribe failed:", res.status, res.statusText, await res.text())
        return false
      }
      return true
    },
    (err) => {
      console.error("Failed to subscribe enterprise email:", err)
      return false
    },
  )
}

export async function POST(event: APIEvent) {
  const dict = i18n(localeFromRequest(event.request))
  try {
    const body = (await event.request.json()) as EnterpriseFormData
    const trap = typeof body.alias === "string" ? body.alias.trim() : ""

    if (trap) {
      return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
    }

    if (!body.name || !body.role || !body.email || !body.message) {
      return Response.json({ error: dict["enterprise.form.error.allFieldsRequired"] }, { status: 400 })
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(body.email)) {
      return Response.json({ error: dict["enterprise.form.error.invalidEmailFormat"] }, { status: 400 })
    }

    const emailContent = `
${body.message}<br><br>
--<br>
${body.name}<br>
${body.role}<br>
${body.company ? `${body.company}<br>` : ""}${body.email}<br>
${body.phone ? `${body.phone}<br>` : ""}`.trim()

    const [lead, mail, octopus] = await Promise.all([
      createLead({
        name: body.name,
        role: body.role,
        company: body.company,
        email: body.email,
        phone: body.phone,
        message: body.message,
      }).catch((err) => {
        console.error("Failed to create Salesforce lead:", err)
        return false
      }),
      AWS.sendEmail({
        to: Resource.ENTERPRISE_SALES_INBOX_EMAIL.value,
        subject: `Enterprise Inquiry from ${body.name}`,
        body: emailContent,
        replyTo: body.email,
      }).then(
        () => true,
        (err) => {
          console.error("Failed to send enterprise email:", err)
          return false
        },
      ),
      subscribe(body.email, body.name),
    ])

    if (!lead && !mail && !octopus) {
      if (import.meta.env.DEV) {
        console.warn("Enterprise inquiry accepted in dev mode without integrations", { email: body.email })
        return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
      }
      console.error("Enterprise inquiry delivery failed", { email: body.email })
      return Response.json({ error: dict["enterprise.form.error.internalServer"] }, { status: 500 })
    }

    return Response.json({ success: true, message: dict["enterprise.form.success.submitted"] }, { status: 200 })
  } catch (error) {
    console.error("Error processing enterprise form:", error)
    return Response.json({ error: dict["enterprise.form.error.internalServer"] }, { status: 500 })
  }
}
