// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UsersPageTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.E2E
// =============================================

using UI.Tests.E2E.Fixtures;

namespace UI.Tests.E2E;

[Collection(WebAppCollectionDefinition.Name)]
public class UsersPageTests(WebAppFixture fixture)
{
	[Fact]
	public async Task AdminUsers_OpenedByVisitor_IsSentTowardSignInWithTheUsersPageAsReturnUrl()
	{
		// Arrange
		CancellationToken cancellationToken = TestContext.Current.CancellationToken;
		await using WebAppPage webAppPage = await fixture.CreatePageAsync(cancellationToken);
		IPage page = webAppPage.Page;

		// Act
		// The request context shares the page's cookies (none, for a Visitor) and stops at the first redirect, so the
		// test reads where the app sends a Visitor without following the sign-in on to Auth0, which a placeholder
		// tenant can't answer.
		IAPIResponse response = await page.Context.APIRequest.GetAsync(
			new Uri(fixture.BaseAddress, "/admin/users").ToString(), new() { MaxRedirects = 0 });

		// Assert
		response.Status.Should().Be(302);
		response.Headers.Should().ContainKey("location");
		string location = response.Headers["location"];
		location.Should().Contain("/authentication/login");
		location.Should().Contain("returnUrl=%2Fadmin%2Fusers");
	}
}
