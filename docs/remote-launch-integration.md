# Open remote sessions from another system

This guide adds a **Connect** button to another web application, such as a customer file, that
opens a browser RDP or SSH session in NetBird Control with stored credentials. The other
application's server calls the API. The browser only follows a one-time link, so it never sees
the credentials.

The full API is in the [public API reference](api.md).

## Before you start

- Browser remote access is on and working: see [Browser remote access](remote-access.md).
- The people who will click the button sign in to NetBird Control with SSO, hold the **Browser
  Remote Access** permission, and have NetBird access to the servers they open.
- The other application sends its requests from its server, over HTTPS, and checks the TLS
  certificate of NetBird Control.

> [!WARNING]
> If the other application turns off certificate checks anywhere in its process, for example with a
> `ServicePointManager.ServerCertificateValidationCallback` that accepts every certificate, fix
> that first. Such a callback applies to every later HTTPS call in the process, so anyone between
> the two servers could read the API key and the passwords.

## Create a key

1. In NetBird Control, open **Settings → API Keys** and click **Create Key**.
2. Enter a name, such as `Customer File`, and keep **Open Remote Sessions** checked.
3. Optional: under **Allowed Addresses**, enter the address the other application's server calls
   from.
4. Click **Create Key** and copy the key. It is shown only once.

## Store the key and the credentials

- Keep the key out of source code, out of tracked files, and out of logs. In ASP.NET, put it in
  `appSettings` and encrypt that section with protected configuration:

	```
	aspnet_regiis -pef "appSettings" "C:\path\to\site"
	```

- Read the target's user name and password from the application's own credential store when the
  button is clicked. Don't copy them into configuration files.
- Refuse to call the API when the key is missing.
- If a key or a password was ever committed to a repository or sent somewhere it shouldn't go,
  treat it as public: revoke the key in **Settings → API Keys**, create a new one, and change the
  password.

## Call the API when the button is clicked

Send the target, the credentials, and the email address of the person who clicked. With the email
address, NetBird Control answers at once if that person has no access, and only that person can
open the link. Without it, whoever opens the link first gets the session.

This example is for ASP.NET WebForms on .NET Framework 4.6.1:

```csharp
using System;
using System.Collections.Generic;
using System.Configuration;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

public static class NetBirdLaunch
{
	// Returns the link to send the browser to. Throws with NetBird Control's message on an error.
	public static string CreateLink(string techEmail, string protocol, string address, int port,
		string username, string password)
	{
		string key = ConfigurationManager.AppSettings["NetBirdControlApiKey"];
		string baseUrl = ConfigurationManager.AppSettings["NetBirdControlUrl"];
		if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(baseUrl))
			throw new InvalidOperationException("NetBird Control is not configured.");

		var json = new JavaScriptSerializer();
		byte[] body = Encoding.UTF8.GetBytes(json.Serialize(new Dictionary<string, object> {
			{ "user", techEmail }, { "protocol", protocol }, { "address", address }, { "port", port },
			{ "username", username }, { "password", password },
		}));

		ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
		var request = (HttpWebRequest)WebRequest.Create(baseUrl.TrimEnd('/') + "/api/v1/remote-access/launch");
		request.Method = "POST";
		request.ContentType = "application/json";
		request.Headers["Authorization"] = "Bearer " + key;
		request.Timeout = 15000;
		using (Stream s = request.GetRequestStream()) s.Write(body, 0, body.Length);

		try
		{
			using (var response = (HttpWebResponse)request.GetResponse())
			using (var reader = new StreamReader(response.GetResponseStream()))
			{
				var result = json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
				return (string)result["url"];
			}
		}
		catch (WebException e) when (e.Response != null)
		{
			using (var reader = new StreamReader(e.Response.GetResponseStream()))
			{
				var error = json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
				throw new InvalidOperationException((string)error["error"]);
			}
		}
	}
}
```

In the button's handler, send the browser to the link, and show the error message on the page if
the call failed:

```csharp
string url = NetBirdLaunch.CreateLink(techEmail, "rdp", server.IP, port, server.User, password);
Response.Redirect(url, false);
```

Never log the request body. It holds the password.

## What the user sees

1. The browser opens NetBird Control. If the user is not signed in, SSO signs them in first, and the
   link continues after that.
2. The session opens in a tab. If the stored password is wrong, the tab asks for the user name and
   password.
3. If the link is older than five minutes or was already used, the page says so. Click the button
   again for a new link.

If the user's tab is managing an MSP tenant, NetBird Control offers to switch to the main account
and then opens the connection.
