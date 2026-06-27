using CSharpSolutionExplorer.Sample.Library.Models;
using CSharpSolutionExplorer.Sample.Library.Services;
using Xunit;

namespace CSharpSolutionExplorer.Sample.Tests;

public class CustomerServiceTests
{
    [Fact]
    public void AddCustomer_ShouldAddCustomerToList()
    {
        var service = new CustomerService();
        var customer = new Customer { Id = 1, Name = "John Doe", Email = "john@example.com" };

        service.AddCustomer(customer);
        var retrieved = service.GetCustomer(1);

        Assert.NotNull(retrieved);
        Assert.Equal("John Doe", retrieved.Name);
    }

    [Fact]
    public void GetAllCustomers_ShouldReturnAllCustomers()
    {
        var service = new CustomerService();
        service.AddCustomer(new Customer { Id = 1, Name = "Alice" });
        service.AddCustomer(new Customer { Id = 2, Name = "Bob" });

        var all = service.GetAllCustomers();

        Assert.Equal(2, all.Count);
    }
}
